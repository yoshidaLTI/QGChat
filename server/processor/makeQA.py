# server/processor/makeQA.py
import argparse, os, json, sqlite3, time, re, requests, sys
from datetime import datetime


# Ollama設定
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434/api/generate")
MODEL_NAME = os.environ.get("QG_MODEL", "gpt-oss")


def write_progress(path, stage, message):
    if not path:
        return
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"stage": stage, "message": message}, f, ensure_ascii=False)
    except Exception:
        pass


def extract_json_array(text):
    try:
        obj = json.loads(text)
        if isinstance(obj, list):
            return obj
    except Exception:
        pass
    s = text.find('[')
    if s != -1:
        depth = 0
        for i, ch in enumerate(text[s:], start=s):
            if ch == '[':
                depth += 1
            elif ch == ']':
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[s:i+1])
                    except Exception:
                        break
    try:
        m = re.search(r'\[\s*{.*?}\s*\]', text, flags=re.DOTALL)
        if m:
            return json.loads(m.group(0))
    except Exception:
        pass
    return None


PROMPT_TMPL = """あなたは{course}の講師です。以下のOCR要約と音声書き起こしに基づき、
学生の理解度を確認する良質な「問題」と「解答」を3件ほど日本語で作成してください。
各問題は単独で意味が通るようにし、曖昧さを避けてください。


厳守: 出力は **必ず** 次のJSON配列のみ。説明文やコードブロックは付けないこと。
[
  {{"question":"...","answer":"..."}},
  {{"question":"...","answer":"..."}}
]


# OCR要約（統合）
{ocr5}


# 音声書き起こし（{ident}）
{asr}
"""


def call_ollama(prompt, model=MODEL_NAME):
    r = requests.post(OLLAMA_URL, json={
        "model": model,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.2, "num_ctx": 4096}
    }, timeout=600)
    r.raise_for_status()
    return r.json().get("response", "").strip()


def make_groups(total: int, k: int = 20):
    if total <= k:
        return [(0, total)]
    groups = []
    full = (total // k) * k
    for i in range(0, full, k):
        groups.append((i, i + k))
    if total % k != 0:
        groups.append((total - k, total))
    dedup = []
    for g in groups:
        if not dedup or dedup[-1] != g:
            dedup.append(g)
    return dedup


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--user-id", type=int, required=True)
    ap.add_argument("--course", required=True)
    ap.add_argument("--video-name", required=True)
    ap.add_argument("--progress", required=False)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--group-size", type=int, default=8)
    ap.add_argument("--max-asr-chars", type=int, default=8000)
    ap.add_argument("--max-ocr-chars", type=int, default=2000)
    args = ap.parse_args()


    # DB存在確認
    db_path = os.path.abspath(args.db)
    if not os.path.exists(db_path):
        print(f"[ERROR] DBファイルが見つかりません: {db_path}", file=sys.stderr)
        sys.exit(1)


    write_progress(args.progress, "qa", "問題生成: 準備中")


    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    print(f"[INFO] 接続DB: {db_path}", file=sys.stderr)


    # --- ASR結果のロード（course_nameが一致しない場合もフォールバック） ---
    cur.execute("""
      SELECT identifier, ocr_context5, asr_text, start_sec, end_sec
      FROM asr_results
      WHERE user_id = ? AND video_name = ?
      ORDER BY start_sec ASC
    """, (args.user_id, args.video_name))
    rows = cur.fetchall()


    if not rows:
        cur.execute("""
          SELECT identifier, ocr_context5, asr_text, start_sec, end_sec
          FROM asr_results
          WHERE user_id = ? AND course_name = ? AND video_name = ?
          ORDER BY start_sec ASC
        """, (args.user_id, args.course, args.video_name))
        rows = cur.fetchall()


    print(f"[INFO] 読み込んだ asr_results 件数: {len(rows)}", file=sys.stderr)


    if not rows:
        print("[WARN] asr_results が空です", file=sys.stderr)
        write_progress(args.progress, "qa", "ASR結果が見つかりません（スキップ）")
        return 0


    # qg_items 作成（既存DBとの整合性OK）
    cur.execute("""
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
        created_at TEXT NOT NULL
      )
    """)
    con.commit()


    cur.execute("""
      SELECT identifier FROM qg_items WHERE user_id=? AND video_name=?
    """, (args.user_id, args.video_name))
    already = set(r[0] for r in cur.fetchall())


    total = len(rows)
    groups = make_groups(total, k=args.group_size)


    done_cnt = 0
    for gi, (s, e) in enumerate(groups, start=1):
        chunk = rows[s:e]
        if not chunk:
            continue


        first_id = chunk[0]["identifier"]
        last_id  = chunk[-1]["identifier"]
        group_ident = f"{first_id}..{last_id}"


        if group_ident in already:
            continue
        if args.limit and done_cnt >= args.limit:
            break


        non_empty = [r for r in chunk if (r["asr_text"] or "").strip()]
        if not non_empty:
            continue


        ocr_parts, asr_parts = [], []
        for r in non_empty:
            ident = r["identifier"]
            ss, ee = r["start_sec"], r["end_sec"]
            ocr_txt = (r["ocr_context5"] or "").strip()
            asr_txt = (r["asr_text"] or "").strip()
            if ocr_txt:
                ocr_parts.append(ocr_txt)
            if asr_txt:
                asr_parts.append(f"[{ident} {ss:.1f}-{ee:.1f}s]\n{asr_txt}")


        if not asr_parts:
            continue


        ocr_merged = " / ".join(ocr_parts)[:args.max_ocr_chars]
        asr_merged = "\n\n---\n\n".join(asr_parts)[:args.max_asr_chars]


        prompt = PROMPT_TMPL.format(
            course=args.course,
            ocr5=ocr_merged or "(OCR情報なし)",
            asr=asr_merged,
            ident=group_ident
        )


        write_progress(args.progress, "qa", f"問題生成: {gi}/{len(groups)} {group_ident} ({e - s} recs)")
        try:
            print(f"[INFO] QG生成 group={group_ident} ({len(asr_parts)}区間)", file=sys.stderr)
            resp = call_ollama(prompt)
            arr = extract_json_array(resp)
            if not arr or not isinstance(arr, list):
                print(f"[WARN] JSON抽出失敗 group={group_ident}", file=sys.stderr)
                continue


            now = datetime.utcnow().isoformat()
            inserted = False
            for item in arr:
                q = (item.get("question") or "").strip()
                a = (item.get("answer") or "").strip()
                if not q or not a:
                    continue
                cur.execute("""
                  INSERT INTO qg_items
                  (user_id, course_name, video_name, identifier, ocr5, asr_text, question, answer, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (args.user_id, args.course, args.video_name, group_ident, ocr_merged, asr_merged, q, a, now))
                inserted = True


            if inserted:
                con.commit()
                done_cnt += 1
                already.add(group_ident)


        except Exception as e:
            print(f"[WARN] QG生成失敗 group={group_ident}: {e}", file=sys.stderr)
            continue


    write_progress(args.progress, "done", f"問題生成 完了（{done_cnt}グループ）")
    print(f"[INFO] 問題生成 完了（{done_cnt}グループ）", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())





