// reset.js
import fs from "fs";
import path from "path";

const BASE = path.resolve("./"); // カレントは server/
const DB_PATH = path.join(BASE, "chat.sqlite3");
const DB_SHM = path.join(BASE, "chat.sqlite3-shm");
const DB_WAL = path.join(BASE, "chat.sqlite3-wal");
const PROGRESS_DIR = path.join(BASE, "progress");
const UPLOADS_DIR = path.join(BASE, "uploads");

// ======= ユーティリティ =======
function safeDelete(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { recursive: true, force: true });
      console.log(`🗑️ Deleted: ${filePath}`);
    }
  } catch (e) {
    console.error(`⚠️ Failed to delete ${filePath}:`, e.message);
  }
}

// ======= 実行ロジック =======
const mode = process.argv[2]?.toUpperCase();

if (!mode || !["ALL", "LOG", "USER", "MOVIE"].includes(mode)) {
  console.log(`
Usage:
  node reset.js [MODE]

MODE:
  ALL     → すべてのデータを削除（LOG + USER + MOVIE）
  LOG     → progress/ のログを削除
  USER    → SQLite データベース(chat.sqlite3 系3ファイル)を削除
  MOVIE   → uploads/ のアップロード動画を削除
`);
  process.exit(0);
}

if (mode === "ALL" || mode === "LOG") {
  console.log("🧹 Deleting progress logs...");
  safeDelete(PROGRESS_DIR);
  fs.mkdirSync(PROGRESS_DIR, { recursive: true });
}

if (mode === "ALL" || mode === "USER") {
  console.log("🧹 Deleting user DB files...");
  [DB_PATH, DB_SHM, DB_WAL].forEach(safeDelete);
}

if (mode === "ALL" || mode === "MOVIE") {
  console.log("🧹 Deleting uploaded movies...");
  safeDelete(UPLOADS_DIR);
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

console.log("✅ Reset complete.");





