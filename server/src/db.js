// db.js
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const dbPath = path.join(process.cwd(), "chat.sqlite3");
const firstBoot = !fs.existsSync(dbPath);
const db = new Database(dbPath);

db.pragma("foreign_keys = ON");
try { db.pragma("journal_mode = WAL"); } catch {}

/* =========================
 * 初期スキーマ作成
 * ========================= */
if (firstBoot) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (...);

    CREATE TABLE IF NOT EXISTS conversations (...);

    CREATE TABLE IF NOT EXISTS messages (...);

    CREATE TABLE IF NOT EXISTS documents (...);

    /* 生成結果（講義ごとセット） */
    CREATE TABLE IF NOT EXISTS qg_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      course_name TEXT NOT NULL,
      doc_id INTEGER,
      doc_title TEXT,
      pattern INTEGER,
      problem_count INTEGER,
      set_name TEXT,
      meta TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    /* OCR (30秒ごと) */
    CREATE TABLE IF NOT EXISTS ocr_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      course_name TEXT NOT NULL,
      video_name TEXT NOT NULL,
      ts_sec INTEGER NOT NULL,
      identifier TEXT NOT NULL,
      ocr_text TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    /* ASR (30秒窓ごと) */
    CREATE TABLE IF NOT EXISTS asr_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      course_name TEXT NOT NULL,
      video_name TEXT NOT NULL,
      start_sec INTEGER NOT NULL,
      end_sec INTEGER NOT NULL,
      identifier TEXT NOT NULL,
      ocr_context5 TEXT,
      asr_text TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    /* 生成された問題の明細 */
    CREATE TABLE IF NOT EXISTS qg_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      course_name TEXT NOT NULL,
      video_name TEXT NOT NULL,
      identifier TEXT NOT NULL,
      ocr5 TEXT,
      asr_text TEXT,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    /* インデックス */
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
    CREATE INDEX IF NOT EXISTS idx_docs_user_id ON documents(user_id);
    CREATE INDEX IF NOT EXISTS idx_docs_user_created ON documents(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_qg_user_course ON qg_results(user_id, course_name, created_at);
    CREATE INDEX IF NOT EXISTS idx_ocr_main ON ocr_results(user_id, video_name, ts_sec);
    CREATE INDEX IF NOT EXISTS idx_asr_main ON asr_results(user_id, video_name, start_sec);
    CREATE INDEX IF NOT EXISTS idx_qg_items_user ON qg_items(user_id, course_name, created_at);
  `);
} else {
  // 既存DBに対するマイグレーション
  const convCols = db.prepare("PRAGMA table_info(conversations)").all().map(c => c.name);
  if (!convCols.includes("state")) db.exec(`ALTER TABLE conversations ADD COLUMN state TEXT;`);
  if (!convCols.includes("meta"))  db.exec(`ALTER TABLE conversations ADD COLUMN meta TEXT;`);

  // documents が無い場合
  const hasDocs = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='documents'`).get();
  if (!hasDocs) {
    db.exec(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        stored_filename TEXT NOT NULL,
        original_name TEXT NOT NULL,
        mime TEXT,
        size INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_docs_user_id ON documents(user_id);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_docs_user_created ON documents(user_id, created_at);`);
  }

  // qg_results 無ければ作成
  const hasQG = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='qg_results'`).get();
  if (!hasQG) {
    db.exec(`
      CREATE TABLE qg_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        course_name TEXT NOT NULL,
        doc_id INTEGER,
        doc_title TEXT,
        pattern INTEGER,
        problem_count INTEGER,
        set_name TEXT,
        meta TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_qg_user_course ON qg_results(user_id, course_name, created_at);`);
  }

  // ocr_results 無ければ作成
  const hasOCR = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ocr_results'`).get();
  if (!hasOCR) {
    db.exec(`
      CREATE TABLE ocr_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        course_name TEXT NOT NULL,
        video_name TEXT NOT NULL,
        ts_sec INTEGER NOT NULL,
        identifier TEXT NOT NULL,
        ocr_text TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ocr_main ON ocr_results(user_id, video_name, ts_sec);`);
  }

  // asr_results 無ければ作成
  const hasASR = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='asr_results'`).get();
  if (!hasASR) {
    db.exec(`
      CREATE TABLE asr_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        course_name TEXT NOT NULL,
        video_name TEXT NOT NULL,
        start_sec INTEGER NOT NULL,
        end_sec INTEGER NOT NULL,
        identifier TEXT NOT NULL,
        ocr_context5 TEXT,
        asr_text TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_asr_main ON asr_results(user_id, video_name, start_sec);`);
  }

  // qg_items 無ければ作成
  const hasQGItems = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='qg_items'`).get();
  if (!hasQGItems) {
    db.exec(`
      CREATE TABLE qg_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        course_name TEXT NOT NULL,
        video_name TEXT NOT NULL,
        identifier TEXT NOT NULL,
        ocr5 TEXT,
        asr_text TEXT,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_qg_items_user ON qg_items(user_id, course_name, created_at);`);
  }

  // 既存インデックスの存在保証
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);`);
}


/* =========================
 * ユーティリティ
 * ========================= */
function safeJSON(s) { try { return JSON.parse(s); } catch { return null; } }

/* =========================
 * ユーザ
 * ========================= */
export function createUser(username, password_hash) {
  const now = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)`
  ).run(username, password_hash, now);
  return { id: info.lastInsertRowid, username, created_at: now };
}

export function getUserByUsername(username) {
  return db.prepare(
    `SELECT id, username, password_hash, created_at FROM users WHERE username = ?`
  ).get(username);
}

export function getUserById(id) {
  return db.prepare(
    `SELECT id, username, created_at FROM users WHERE id = ?`
  ).get(id);
}

/* =========================
 * 会話
 * ========================= */
export function createConversation(user_id, title = "新規チャット", state = null, meta = null) {
  const now = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO conversations (user_id, title, state, meta, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(user_id, title, state, meta ? JSON.stringify(meta) : null, now);
  return { id: info.lastInsertRowid, user_id, title, state, created_at: now };
}

export function getConversation(user_id, conversationId) {
  const conv = db.prepare(
    `SELECT id, user_id, title, state, meta, created_at
     FROM conversations WHERE id = ? AND user_id = ?`
  ).get(conversationId, user_id);
  if (!conv) return null;

  const msgs = db.prepare(
    `SELECT id, role, content, created_at
     FROM messages WHERE conversation_id = ? ORDER BY id ASC`
  ).all(conversationId);

  return { ...conv, meta: conv.meta ? safeJSON(conv.meta) : null, messages: msgs };
}

export function listConversations(user_id, limit = 100) {
  return db.prepare(
    `SELECT id, title, state, created_at
     FROM conversations WHERE user_id = ?
     ORDER BY id DESC LIMIT ?`
  ).all(user_id, limit);
}

export function deleteConversation(user_id, conversationId) {
  const row = db.prepare(
    `SELECT id FROM conversations WHERE id = ? AND user_id = ?`
  ).get(conversationId, user_id);
  if (!row) return false;
  db.prepare(`DELETE FROM conversations WHERE id = ?`).run(conversationId);
  return true;
}

export function getConversationState(user_id, conversationId) {
  const row = db.prepare(
    `SELECT state, meta FROM conversations WHERE id = ? AND user_id = ?`
  ).get(conversationId, user_id);
  if (!row) return { state: null, meta: null };
  return {
    state: row.state || null,
    meta: row.meta ? safeJSON(row.meta) : null
  };
}

export function setConversationState(user_id, conversationId, state, meta = null) {
  const ok = db.prepare(
    `SELECT id FROM conversations WHERE id = ? AND user_id = ?`
  ).get(conversationId, user_id);
  if (!ok) return false;

  const metaStr = meta ? JSON.stringify(meta) : null;
  db.prepare(
    `UPDATE conversations SET state = ?, meta = COALESCE(?, meta) WHERE id = ?`
  ).run(state, metaStr, conversationId);
  return true;
}

/* =========================
 * メッセージ
 * ========================= */
export function addMessage(conversationId, role, content) {
  const now = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO messages (conversation_id, role, content, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(conversationId, role, content, now);
  return { id: info.lastInsertRowid, conversation_id: conversationId, role, content, created_at: now };
}

/* =========================
 * 資料（アップロード）
 * ========================= */
export function insertDocument(user_id, title, stored_filename, original_name, mime, size) {
  const now = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO documents (user_id, title, stored_filename, original_name, mime, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(user_id, title, stored_filename, original_name, mime, size, now);

  return {
    id: info.lastInsertRowid,
    user_id,
    title,
    stored_filename,
    original_name,
    mime,
    size,
    created_at: now
  };
}

export function listDocuments(user_id, limit = 10) {
  return db.prepare(
    `SELECT id, title, stored_filename, original_name, mime, size, created_at
     FROM documents
     WHERE user_id = ?
     ORDER BY id DESC
     LIMIT ?`
  ).all(user_id, limit);
}

export function listDocumentsAll(user_id) {
  return db.prepare(
    `SELECT id, title, stored_filename, original_name, mime, size, created_at
     FROM documents
     WHERE user_id = ?
     ORDER BY id DESC`
  ).all(user_id);
}

// keep 件数だけ残し、超過分（古い順）を削除して返す
export function deleteOldDocumentsKeepLatest(user_id, keep = 10, onBeforeDelete = null) {
  const all = listDocumentsAll(user_id); // DESC
  if (all.length <= keep) return [];

  const toDelete = [...all].sort((a, b) => a.id - b.id).slice(0, all.length - keep);
  const stmt = db.prepare(`DELETE FROM documents WHERE id = ? AND user_id = ?`);
  for (const row of toDelete) {
    if (onBeforeDelete) {
      try { onBeforeDelete(row); } catch {}
    }
    stmt.run(row.id, user_id);
  }
  return toDelete;
}

/* =========================
 * 生成結果（qg_results）
 * ========================= */
export function insertQGResult(
  user_id,
  { course_name, doc_id = null, doc_title = null, pattern = null, problem_count = null, set_name = null, meta = null }
) {
  const now = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO qg_results
     (user_id, course_name, doc_id, doc_title, pattern, problem_count, set_name, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    user_id,
    course_name,
    doc_id,
    doc_title,
    pattern,
    problem_count,
    set_name,
    meta ? JSON.stringify(meta) : null,
    now
  );

  return {
    id: info.lastInsertRowid,
    user_id,
    course_name,
    doc_id,
    doc_title,
    pattern,
    problem_count,
    set_name,
    meta,
    created_at: now
  };
}

export function listQGResultsByUser(user_id) {
  const rows = db.prepare(
    `SELECT id, course_name, doc_id, doc_title, pattern, problem_count, set_name, meta, created_at
     FROM qg_results
     WHERE user_id = ?
     ORDER BY course_name ASC, created_at DESC`
  ).all(user_id);
  return rows.map(r => ({ ...r, meta: r.meta ? safeJSON(r.meta) : null }));
}

// --- 末尾のエクスポート群に関数を追加 ---
export function insertOCRResult({ user_id, course_name, video_name, ts_sec, identifier, ocr_text }) {
  const now = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO ocr_results (user_id, course_name, video_name, ts_sec, identifier, ocr_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(user_id, course_name, video_name, ts_sec, identifier, ocr_text ?? null, now);
  return { id: info.lastInsertRowid };
}

export function insertASRResult({ user_id, course_name, video_name, start_sec, end_sec, identifier, ocr_context5, asr_text }) {
  const now = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO asr_results (user_id, course_name, video_name, start_sec, end_sec, identifier, ocr_context5, asr_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(user_id, course_name, video_name, start_sec, end_sec, identifier, ocr_context5 ?? null, asr_text ?? null, now);
  return { id: info.lastInsertRowid };
}

export function insertQGItem({ user_id, course_name, video_name, identifier, ocr5, asr_text, question, answer }) {
  const now = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO qg_items (user_id, course_name, video_name, identifier, ocr5, asr_text, question, answer, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(user_id, course_name, video_name, identifier, ocr5 ?? null, asr_text ?? null, question, answer, now);
  return { id: info.lastInsertRowid };
}

export function listQGItemsByUser(user_id, { course_name = null, limit = 200 } = {}) {
  if (course_name) {
    return db.prepare(`
      SELECT id, course_name, video_name, identifier, ocr5, asr_text, question, answer, created_at
      FROM qg_items
      WHERE user_id = ? AND course_name = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(user_id, course_name, limit);
  }
  return db.prepare(`
    SELECT id, course_name, video_name, identifier, ocr5, asr_text, question, answer, created_at
    FROM qg_items
    WHERE user_id = ?
    ORDER BY course_name ASC, created_at DESC
    LIMIT ?
  `).all(user_id, limit);
}
