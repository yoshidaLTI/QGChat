// server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import fs from "fs";
import multer from "multer";
import { spawn } from "child_process";
import crypto from "crypto";
import Database from "better-sqlite3";

// DB
import {
  createUser,
  getUserByUsername,
  getUserById,
  createConversation,
  getConversation,
  addMessage,
  listConversations,
  deleteConversation,
  getConversationState,
  setConversationState,
  // materials/docs
  listDocuments,
  insertDocument,
  deleteOldDocumentsKeepLatest,
  insertQGResult,
  listQGResultsByUser
} from "./db.js";

// 任意 LLM フォールバック
import { generateLLMReply } from "./llm.js";

// Auth
import {
  cookies,
  requireAuth,
  signToken,
  setAuthCookie,
  clearAuthCookie,
  verifyToken
} from "./auth.js";

// ========== 定数/ユーティリティ ==========
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPLOAD_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const PROGRESS_DIR = path.join(process.cwd(), "progress");
if (!fs.existsSync(PROGRESS_DIR)) fs.mkdirSync(PROGRESS_DIR, { recursive: true });

function sanitizeName(name) { return name.replace(/[^\w.\-()+\s]/g, "_"); }
function progressFile(jobId) { return path.join(PROGRESS_DIR, `${jobId}.json`); }

// convId -> jobId の対応（同時ジョブの上書きOK）
const convJobMap = new Map(); // key: `${userId}:${convId}` -> jobId

// ========== ルールベース応答 ==========
function parseKV(command) {
  const m = command.replace(/^set\s*:\s*/i, "");
  const kvs = m.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  const out = {};
  for (const kv of kvs) {
    const [k, v] = kv.split("=").map(x => x && x.trim());
    if (k && v) out[k.toLowerCase()] = v;
  }
  return out;
}

function matchRuleIntent(text, state, meta = {}) {
  const t = (text || "").trim();

  const is11 = /(^(1[-‐–—]?1)\b|既存.*資料.*(問題|作成)|既存資料.*作成)/i.test(t);
  const is12 = /(^(1[-‐–—]?2)\b|新規.*資料.*(アップロード|問題|作成)|アップロード.*問題)/i.test(t);
  const help = /(ヘルプ|使い方|help)/i.test(t);
  const back = /^(戻る|back)$/i.test(t);
  const home = /^(home|メニュー)$/i.test(t);

  const selectDoc = /^select\s+doc\s*:\s*(\d+)/i.exec(t);
  const setCmd = /^set\s*:/i.test(t) ? parseKV(t) : null;
  const run = /^(run|実行)$/i.test(t);

  switch (state) {
    case "ROOT_MENU":
    default: {
      if (is11) {
        return {
          reply:
`既存資料から問題を作成します。
資料を選択してください（例: "select doc: 123"）。
- 最近使った資料: 101, 102, 103
- 設定は後から "set: questions=10, difficulty=middle, type=mcq" で変更可能です。`,
          newState: "FLOW_EXISTING_DOC_SELECT",
          metaPatch: { lastChoice: "1-1" }
        };
      }
      if (is12) {
        return {
          reply:
`新規資料のアップロードから開始します。
アップロード完了後、"uploaded: <docId>" と入力してください（例: "uploaded: 201"）。`,
          newState: "FLOW_UPLOAD_DOC_WAIT",
          metaPatch: { lastChoice: "1-2" }
        };
      }
      if (help) {
        return { reply: "ヘルプ: 1-1 既存資料 / 1-2 新規アップロード から開始します。", newState: "ROOT_MENU" };
      }
      return null;
    }

    case "FLOW_EXISTING_DOC_SELECT": {
      if (home) return { reply: "メニューに戻ります。", newState: "ROOT_MENU" };
      if (back) return { reply: "一つ前に戻ります。", newState: "ROOT_MENU" };
      if (selectDoc) {
        const docId = Number(selectDoc[1]);
        const current = meta.config || { questions: 10, difficulty: "middle", type: "mcq" };
        return {
          reply:
`資料 ${docId} を選択しました。
現在の設定: questions=${current.questions}, difficulty=${current.difficulty}, type=${current.type}
変更する場合は "set: questions=20, difficulty=hard"、問題生成は "run" と入力してください。`,
          newState: "FLOW_EXISTING_DOC_CONFIG",
          metaPatch: { docId }
        };
      }
      return { reply: '資料を「select doc: <id>」で指定してください。', newState: "FLOW_EXISTING_DOC_SELECT" };
    }

    case "FLOW_EXISTING_DOC_CONFIG": {
      if (home) return { reply: "メニューに戻ります。", newState: "ROOT_MENU" };
      if (back) return { reply: "資料選択に戻ります。", newState: "FLOW_EXISTING_DOC_SELECT" };
      if (setCmd) {
        const prev = meta.config || {};
        const config = {
          questions: Number(setCmd.questions ?? prev.questions ?? 10),
          difficulty: (setCmd.difficulty ?? prev.difficulty ?? "middle"),
          type: (setCmd.type ?? prev.type ?? "mcq")
        };
        return {
          reply:
`設定を更新しました。
questions=${config.questions}, difficulty=${config.difficulty}, type=${config.type}
問題生成する場合は "run" と入力してください。`,
          newState: "FLOW_EXISTING_DOC_CONFIG",
          metaPatch: { config }
        };
      }
      if (run) {
        const cfg = meta.config || { questions: 10, difficulty: "middle", type: "mcq" };
        return {
          reply:
`問題生成を開始します（ダミー）。
資料=${meta.docId}, questions=${cfg.questions}, difficulty=${cfg.difficulty}, type=${cfg.type}
生成が完了しました。結果をプレビューできます。`,
          newState: "FLOW_QG_DONE",
          metaPatch: { lastRunAt: new Date().toISOString() }
        };
      }
      return null;
    }

    case "FLOW_UPLOAD_DOC_WAIT": {
      if (home) return { reply: "メニューに戻ります。", newState: "ROOT_MENU" };
      if (back) return { reply: "メニューに戻ります。", newState: "ROOT_MENU" };
      const uploaded = /^uploaded\s*:\s*(\d+)/i.exec(t);
      if (uploaded) {
        const docId = Number(uploaded[1]);
        const current = meta.config || { questions: 10, difficulty: "middle", type: "mcq" };
        return {
          reply:
`アップロード完了を受け付けました。docId=${docId}
現在の設定: questions=${current.questions}, difficulty=${current.difficulty}, type=${current.type}
必要に応じて "set: ..." で更新し、"run" で生成を開始してください。`,
          newState: "FLOW_UPLOAD_DOC_CONFIG",
          metaPatch: { docId }
        };
      }
      return { reply: 'アップロード完了後は「uploaded: <docId>」と入力してください。', newState: "FLOW_UPLOAD_DOC_WAIT" };
    }

    case "FLOW_UPLOAD_DOC_CONFIG": {
      if (home) return { reply: "メニューに戻ります。", newState: "ROOT_MENU" };
      if (back) return { reply: "アップロード待ちに戻ります。", newState: "FLOW_UPLOAD_DOC_WAIT" };
      if (setCmd) {
        const prev = meta.config || {};
        const config = {
          questions: Number(setCmd.questions ?? prev.questions ?? 10),
          difficulty: (setCmd.difficulty ?? prev.difficulty ?? "middle"),
          type: (setCmd.type ?? prev.type ?? "mcq")
        };
        return {
          reply:
`設定を更新しました。
questions=${config.questions}, difficulty=${config.difficulty}, type=${config.type}
問題生成する場合は "run" と入力してください。`,
          newState: "FLOW_UPLOAD_DOC_CONFIG",
          metaPatch: { config }
        };
      }
      if (run) {
        const cfg = meta.config || { questions: 10, difficulty: "middle", type: "mcq" };
        return {
          reply:
`問題生成を開始します（ダミー）。
資料=${meta.docId}, questions=${cfg.questions}, difficulty=${cfg.difficulty}, type=${cfg.type}
生成が完了しました。結果をプレビューできます。`,
          newState: "FLOW_QG_DONE",
          metaPatch: { lastRunAt: new Date().toISOString() }
        };
      }
      return null;
    }

    case "FLOW_QG_DONE": {
      if (home) return { reply: "メニューに戻ります。", newState: "ROOT_MENU" };
      if (back) return { reply: "設定に戻ります。", newState: meta.lastChoice === "1-1" ? "FLOW_EXISTING_DOC_CONFIG" : "FLOW_UPLOAD_DOC_CONFIG" };
      return null;
    }
  }
}

// ========== Express ==========
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(cookies);

// 静的
app.use(express.static(path.join(__dirname, "../../public")));
app.get("/login", (_req, res) => res.sendFile(path.join(__dirname, "../../public/login.html")));
app.get("/signup", (_req, res) => res.sendFile(path.join(__dirname, "../../public/signup.html")));

// ========== 認証 ==========
app.post("/api/auth/signup", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username, password は必須です。" });
  const exists = getUserByUsername(username);
  if (exists) return res.status(409).json({ error: "既に存在するユーザ名です。" });
  const hash = await bcrypt.hash(password, 10);
  const user = createUser(username, hash);
  const token = signToken({ sub: user.id, username: user.username });
  setAuthCookie(res, token);
  res.json({ id: user.id, username: user.username });
});
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username, password は必須です。" });
  const user = getUserByUsername(username);
  if (!user) return res.status(401).json({ error: "認証に失敗しました。" });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "認証に失敗しました。" });
  const token = signToken({ sub: user.id, username: user.username });
  setAuthCookie(res, token);
  res.json({ id: user.id, username: user.username });
});
app.post("/api/auth/logout", (_req, res) => { clearAuthCookie(res); res.json({ ok: true }); });
app.get("/api/me", (req, res) => {
  const token = req.cookies?.auth;
  if (!token) return res.status(200).json({ user: null });
  const v = verifyToken(token);
  if (!v?.sub) return res.status(200).json({ user: null });
  const user = getUserById(v.sub);
  res.json({ user });
});

// ========== 会話 ==========
app.post("/api/conversations", requireAuth, (req, res) => {
  const { title } = req.body || {};
  const conv = createConversation(req.user.id, title ?? "新規チャット", "ROOT_MENU");
  res.json(conv);
});
app.get("/api/conversations", requireAuth, (req, res) => res.json(listConversations(req.user.id, 100)));
app.get("/api/conversations/:id", requireAuth, (req, res) => {
  const convId = Number(req.params.id);
  const conv = getConversation(req.user.id, convId);
  if (!conv) return res.status(404).json({ error: "conversation not found" });
  res.json(conv);
});
app.delete("/api/conversations/:id", requireAuth, (req, res) => {
  const convId = Number(req.params.id);
  if (!Number.isFinite(convId)) return res.status(400).json({ error: "invalid id" });
  const ok = deleteConversation(req.user.id, convId);
  if (!ok) return res.status(404).json({ error: "conversation not found" });
  res.json({ ok: true });
});

// ========== 生成結果 ==========
app.post("/api/results", requireAuth, (req, res) => {
  const { conversationId, pattern } = req.body || {};
  const convId = Number(conversationId);
  if (!Number.isFinite(convId)) return res.status(400).json({ error: "invalid conversationId" });
  const { meta } = getConversationState(req.user.id, convId) || {};
  const course = meta?.courseName || "未設定";
  const docId = meta?.docId || null;
  const docTitle = meta?.docTitle || null;
  const result = insertQGResult(req.user.id, {
    course_name: course,
    doc_id: docId,
    doc_title: docTitle,
    pattern: Number(pattern) || 1,
    problem_count: 10,
    set_name: null,
    meta: { model: "gpt-oss", source: "2-2" }
  });
  res.json(result);
});
app.get("/api/results", requireAuth, (req, res) => res.json(listQGResultsByUser(req.user.id)));

// ========== チャット ==========
app.post("/api/chat", requireAuth, async (req, res) => {
  try {
    const { conversationId, userMessage } = req.body;
    if (!conversationId || !userMessage || !userMessage.trim()) {
      return res.status(400).json({ error: "conversationId と userMessage は必須です。" });
    }
    const conv = getConversation(req.user.id, Number(conversationId));
    if (!conv) return res.status(404).json({ error: "conversation not found" });

    addMessage(conv.id, "user", userMessage);

    const { state, meta } = getConversationState(req.user.id, conv.id);
    const ruleHit = matchRuleIntent(userMessage, state || "ROOT_MENU", meta || {});
    if (ruleHit) {
      const newMeta = { ...(meta || {}), ...(ruleHit.metaPatch || {}) };
      setConversationState(req.user.id, conv.id, ruleHit.newState || state, newMeta);
      const saved = addMessage(conv.id, "assistant", ruleHit.reply);
      return res.json({ reply: ruleHit.reply, messageId: saved.id });
    }

    const messages = [
      { role: "system", content: "あなたは丁寧で簡潔な日本語アシスタントです。" },
      ...conv.messages.map(m => ({ role: m.role, content: m.content })),
      { role: "user", content: userMessage }
    ];
    const { content } = await generateLLMReply(messages);
    const saved = addMessage(conv.id, "assistant", content);
    res.json({ reply: content, messageId: saved.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error", detail: String(err) });
  }
});

// ========== シナリオ状態（FE互換） ==========
const FE_TO_BE = {
  "root": "ROOT_MENU",
  "1": "FLOW_EXISTING_DOC_SELECT",
  "1-course": "FLOW_EXISTING_DOC_COURSE",
  "1-1": "FLOW_EXISTING_DOC_CONFIG",
  "2": "FLOW_UPLOAD_DOC_WAIT",
  "2-course": "FLOW_UPLOAD_DOC_COURSE",
  "2-1": "FLOW_UPLOAD_DOC_CONFIG",
  "2-2": "FLOW_QG_DONE",
  "2-3": "FLOW_QG_TOPIC",
  "2-4": "FLOW_QG_MULTI",
  "2-5": "FLOW_QG_RESULTS"
};
const BE_TO_FE = Object.fromEntries(Object.entries(FE_TO_BE).map(([k, v]) => [v, k]));

app.get("/api/scenario", requireAuth, (req, res) => {
  const convId = Number(req.query.conversationId);
  if (!Number.isFinite(convId)) return res.status(400).json({ error: "invalid conversationId" });
  const conv = getConversation(req.user.id, convId);
  if (!conv) return res.status(404).json({ error: "conversation not found" });
  const { state, meta } = getConversationState(req.user.id, convId) || {};
  const fe = BE_TO_FE[state] || "root";
  res.json({ id: fe, meta: meta || {} });
});
app.post("/api/scenario", requireAuth, (req, res) => {
  const { conversationId, id, metaPatch } = req.body || {};
  const convId = Number(conversationId);
  if (!Number.isFinite(convId) || !id) return res.status(400).json({ error: "invalid params" });
  const conv = getConversation(req.user.id, convId);
  if (!conv) return res.status(404).json({ error: "conversation not found" });
  const nextState = FE_TO_BE[id] || "ROOT_MENU";
  const current = getConversationState(req.user.id, convId) || {};
  const mergedMeta = { ...(current.meta || {}), ...(metaPatch || {}) };
  setConversationState(req.user.id, convId, nextState, mergedMeta);
  res.status(204).end();
});

// ========== 資料アップロード設定（日本語ファイル名対応） ==========
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const userId = req.user?.id || "anon";
    const ts = Date.now();

    // --- ★UTF-8再解釈処理★ ---
    let original = file.originalname;
    // latin1(ISO-8859-1)として誤認された可能性に対処
    original = Buffer.from(original, "latin1").toString("utf8");

    // 禁止文字除去
    const base = path.parse(original).name;
    const ext  = path.extname(original);
    const safeBase = base.replace(/[\\/:*?"<>|]/g, "_");

    const filename = `${userId}_${ts}_${safeBase}${ext}`;
    cb(null, filename);
  }
});

const upload = multer({ storage });

app.get("/api/materials", requireAuth, (req, res) => {
  const rows = listDocuments(req.user.id, 10);
  res.json(rows.map(r => ({ id: r.id, name: r.title || r.original_name || `doc-${r.id}` })));
});
app.post("/api/upload", requireAuth, upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "file は必須です。" });

    const doc = insertDocument(
      req.user.id,
      req.file.originalname,
      req.file.filename,
      req.file.originalname,
      req.file.mimetype,
      req.file.size
    );

    const overflow = deleteOldDocumentsKeepLatest(req.user.id, 10, (row) => {
      const fp = path.join(UPLOAD_DIR, row.stored_filename);
      try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
    });

    res.json({
      ok: true,
      doc: {
        id: doc.id,
        name: doc.title,
        stored_filename: doc.stored_filename
      },
      deleted: overflow.map(o => ({ id: o.id, name: o.title }))
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "upload failed" });
  }
});
app.post("/api/upload/cancel", requireAuth, (_req, res) => res.json({ ok: true }));
app.get("/api/docs", requireAuth, (_req, res) => res.json(listDocuments(req.user.id, 10)));

// ========== 進捗（Python ワーカー起動 & ポーリング統合） ==========

// /api/process/start -> { ok, jobId }
app.post("/api/process/start", requireAuth, async (req, res) => {
  const { conversationId } = req.body || {};
  const conv = getConversation(req.user.id, Number(conversationId));
  if (!conv) return res.status(404).json({ error: "conversation not found" });

  const st = getConversationState(req.user.id, Number(conversationId)) || {};
  const meta = st.meta || {};

  // 動画ファイルの解決
  let stored = meta.stored_filename;
  let videoName = meta.docTitle || meta.videoName;
  if (!stored) {
    const latest = listDocuments(req.user.id, 1)[0];
    if (!latest) return res.status(400).json({ error: "no uploaded document found for the user" });
    stored = latest.stored_filename;
    videoName = latest.original_name || latest.title || stored;
    setConversationState(req.user.id, Number(conversationId), st.state, { ...meta, stored_filename: stored, docTitle: videoName });
  }
  const courseName = meta.courseName || "未設定";

  const jobId = crypto.randomBytes(8).toString("hex");
  const progPath = progressFile(jobId);
  fs.writeFileSync(progPath, JSON.stringify({ stage: "analysis", message: "内容分析処理: OCRを開始" }, null, 2));

  // この会話の最新ジョブを記録（会話IDでポーリングできるように）
  convJobMap.set(`${req.user.id}:${conversationId}`, jobId);

  // 1) OCR/ASR ワーカー
  const pyBin = process.env.PYTHON_BIN || "python3";
  const w1 = spawn(
    pyBin,
    [
      "processor/worker.py",
      "--db", path.join(process.cwd(), "chat.sqlite3"),
      "--user-id", String(req.user.id),
      "--course", courseName,
      "--video-name", videoName,
      "--video-path", path.join(UPLOAD_DIR, stored),
      "--progress", progPath
    ],
    { cwd: process.cwd(), stdio: "ignore" }
  );

  w1.on("error", (e) => {
    fs.writeFileSync(progPath, JSON.stringify({ stage:"error", message:String(e) }));
  });

  w1.on("exit", (code) => {
    // worker 終了時に QA 生成へ
    const ok = code === 0;
    if (!ok) {
      fs.writeFileSync(progPath, JSON.stringify({ stage:"error", message:`worker exit ${code}` }));
      return;
    }
    // ここから makeQA.py をキック
    fs.writeFileSync(progPath, JSON.stringify({ stage:"qa", message:"問題生成: 開始" }));

    const qa = spawn(
      process.env.PYTHON_BIN || "python3",
      [
        "processor/makeQA.py",
        "--db", path.join(process.cwd(), "chat.sqlite3"),
        "--user-id", String(req.user.id),
        "--course", courseName,
        "--video-name", videoName,
        "--progress", progPath
      ],
      { cwd: process.cwd(), stdio: "ignore" }
    );

    qa.on("error", (e) => {
      fs.writeFileSync(progPath, JSON.stringify({ stage:"error", message:String(e) }));
    });
    qa.on("exit", (c2) => {
      const msg = c2 === 0 ? { stage:"done", message:"完了" } : { stage:"error", message:`qa exit ${c2}` };
      fs.writeFileSync(progPath, JSON.stringify(msg));
    });
  });

  res.json({ ok: true, jobId });
});

// /api/process/progress
// - jobId 指定 or conversationId 指定の両対応
app.get("/api/process/progress", requireAuth, (req, res) => {
  const { jobId: qJobId, conversationId } = req.query || {};
  let jobId = qJobId;
  if (!jobId && conversationId) {
    jobId = convJobMap.get(`${req.user.id}:${Number(conversationId)}`);
  }
  if (!jobId) return res.json({ stage: "unknown", message: "" });

  const fp = progressFile(jobId);
  if (!fs.existsSync(fp)) return res.json({ stage: "unknown", message: "" });

  try {
    const j = JSON.parse(fs.readFileSync(fp, "utf-8"));
    return res.json(j);
  } catch {
    return res.json({ stage: "unknown", message: "" });
  }
});

// Q&A 一覧
app.get("/api/qa", requireAuth, (req, res) => {
  const db = new Database(path.join(process.cwd(), "chat.sqlite3"));
  const rows = db.prepare(`
    SELECT id, course_name, video_name, identifier, question, answer, created_at
    FROM qg_items
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 500
  `).all(req.user.id);
  res.json(rows);
});

// ある識別子のQ&A 詳細
app.get("/api/qa/detail", requireAuth, (req, res) => {
  const { identifier } = req.query || {};
  if (!identifier) return res.status(400).json({ error: "identifier is required" });
  const db = new Database(path.join(process.cwd(), "chat.sqlite3"));
  const rows = db.prepare(`
    SELECT id, course_name, video_name, identifier, question, answer, created_at
    FROM qg_items
    WHERE user_id = ? AND identifier = ?
    ORDER BY id ASC
  `).all(req.user.id, String(identifier));
  res.json(rows);
});

// ========== 起動 ==========
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
