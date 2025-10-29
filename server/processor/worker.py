# processor/worker.py
import argparse, os, json, time, sqlite3, subprocess, tempfile
from datetime import timedelta
import cv2
import pytesseract
from mlx_whisper import transcribe  # ← 公式の transcribe 関数を直接利用

STEP_SEC = 30  # 30秒ごと

def hhmmss(sec: int) -> str:
    return str(timedelta(seconds=int(sec)))

def write_progress(path, stage, message):
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"stage": stage, "message": message}, f, ensure_ascii=False)
    except Exception:
        pass

def ensure_tables(db: sqlite3.Connection):
    # 既に db.js で作っていれば NO-OP。なければ作る（安全側）
    db.executescript("""
    CREATE TABLE IF NOT EXISTS ocr_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      course_name TEXT NOT NULL,
      video_name TEXT NOT NULL,
      ts_sec INTEGER NOT NULL,
      identifier TEXT NOT NULL,
      ocr_text TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ocr_user_course ON ocr_results(user_id, course_name);

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
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_asr_user_course ON asr_results(user_id, course_name);
    """)
    db.commit()

def extract_wav_segment(video_path: str, start_sec: int, end_sec: int) -> str:
    """ffmpegで動画から [start, end) の区間を16kHz/mono WAVで切り出す"""
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmpwav = tmp.name
    tmp.close()
    cmd = [
        "ffmpeg",
        "-y",
        "-ss", str(start_sec),
        "-to", str(end_sec),
        "-i", video_path,
        "-vn",
        "-acodec", "pcm_s16le",
        "-ar", "16000",
        "-ac", "1",
        tmpwav
    ]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return tmpwav

def do_ocr_every_step(cap: cv2.VideoCapture, total_sec: int, user_id: int, course: str, video_name: str, db: sqlite3.Connection, progress_path: str):
    """30秒おきにフレームをOCRして DB1(ocr_results) に保存。戻り値は [(ts_sec, text)]"""
    rows = []
    for ts in range(0, total_sec + 1, STEP_SEC):
        # 指定秒のフレームへ
        cap.set(cv2.CAP_PROP_POS_MSEC, ts * 1000)
        ok, frame = cap.read()
        if not ok:
            continue

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        # 日本語+英語の両方
        text = pytesseract.image_to_string(gray, lang="jpn+eng")
        ident = f"{os.path.splitext(video_name)[0]}#{hhmmss(ts)}"

        db.execute(
            "INSERT INTO ocr_results (user_id, course_name, video_name, ts_sec, identifier, ocr_text, created_at) VALUES (?,?,?,?,?,?,datetime('now'))",
            (user_id, course, video_name, ts, ident, text)
        )
        rows.append((ts, text))

        # 5分ごとに進捗
        if ts % (STEP_SEC * 10) == 0:
            write_progress(progress_path, "analysis", f"OCR進行中: {hhmmss(ts)}/{hhmmss(total_sec)}")
    db.commit()
    return rows

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--user-id", required=True, type=int)
    ap.add_argument("--course", required=True)
    ap.add_argument("--video-name", required=True)
    ap.add_argument("--video-path", required=True)
    ap.add_argument("--progress", required=True)
    args = ap.parse_args()

    # Whisper モデルの指定（ローカルキャッシュ推奨）
    # 例) WHISPER_REPO=mlx-community/whisper-large-v3-mlx
    # 例) WHISPER_REPO=/path/to/local/whisper-large-v3-mlx (ローカル展開)
    WHISPER_REPO = os.environ.get("WHISPER_REPO", "mlx-community/whisper-large-v3-mlx")

    db = sqlite3.connect(args.db)
    db.row_factory = sqlite3.Row
    ensure_tables(db)

    write_progress(args.progress, "analysis", "内容分析処理: OCRを開始")

    # 動画オープン
    cap = cv2.VideoCapture(args.video_path)
    if not cap.isOpened():
        write_progress(args.progress, "error", f"動画を開けません: {args.video_path}")
        return 1

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    total_sec = int(total_frames / fps) if total_frames > 0 else 0

    # 1) 30秒毎にOCR → DB1
    ocr_rows = do_ocr_every_step(
        cap, total_sec, args.user_id, args.course, args.video_name, db, args.progress
    )

    cap.release()

    write_progress(args.progress, "qg", "問題生成前処理: Whisperで音声認識")

    for idx, (ts, _) in enumerate(ocr_rows):
        # 前後5件分のOCRを統合（長すぎるとモデルに嫌われるので適度にトリム）
        ctx = []
        for k in range(max(0, idx - 5), min(len(ocr_rows), idx + 6)):
            t = (ocr_rows[k][1] or "").strip()
            if t:
                ctx.append(t)
        ctx_text = " / ".join(ctx)
        if len(ctx_text) > 2000:
            ctx_text = ctx_text[:2000]

        start = ts
        end = min(ts + STEP_SEC, total_sec)
        ident = f"{os.path.splitext(args.video_name)[0]}#{hhmmss(start)}"

        # 区間の音声を一時WAVに切り出す
        tmpwav = extract_wav_segment(args.video_path, start, end)

        try:
            result = transcribe(
                tmpwav,
                path_or_hf_repo=WHISPER_REPO,
                language="ja",
                task="transcribe",
                verbose=False,
                condition_on_previous_text=False,
                carry_initial_prompt=False,
                initial_prompt=ctx_text  
            )
            asr_text = (result or {}).get("text", "").strip()
        except Exception as e:
            asr_text = f"(ASR失敗: {e})"
        finally:
            try:
                os.remove(tmpwav)
            except Exception:
                pass

        db.execute(
            "INSERT INTO asr_results (user_id, course_name, video_name, start_sec, end_sec, identifier, ocr_context5, asr_text, created_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))",
            (args.user_id, args.course, args.video_name, start, end, ident, ctx_text, asr_text)
        )
        # 10チャンクごとにコミット＋進捗
        if idx % 10 == 0:
            db.commit()
            try:
                write_progress(args.progress, "qg", f"ASR進行中: {hhmmss(end)}/{hhmmss(total_sec)}")
            except Exception:
                pass

    db.commit()
    write_progress(args.progress, "done", "完了")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

