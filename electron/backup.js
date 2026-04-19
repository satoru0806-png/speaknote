// SpeakNote バックアップ管理モジュール
// 録音の生テキスト/整形済みテキスト/未処理音声を自動保存し、データ損失を防ぐ
const fs = require("fs");
const path = require("path");
const os = require("os");

const DOCUMENTS_DIR = path.join(os.homedir(), "Documents", "SpeakNote");
const BACKUP_DIR = path.join(DOCUMENTS_DIR, "backup");
const UNPROCESSED_DIR = path.join(DOCUMENTS_DIR, "unprocessed");

const BACKUP_RETAIN_DAYS = 30; // バックアップ保持日数

function ensureDirs() {
  try {
    if (!fs.existsSync(DOCUMENTS_DIR)) fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    if (!fs.existsSync(UNPROCESSED_DIR)) fs.mkdirSync(UNPROCESSED_DIR, { recursive: true });
  } catch (e) {
    console.error("[Backup] mkdir error:", e.message);
  }
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// 録音結果を保存。既存ファイルがあれば整形済みを追記する
function saveBackup({ stamp, rawText, cleanedText, meta }) {
  ensureDirs();
  const filename = `${stamp}.txt`;
  const filepath = path.join(BACKUP_DIR, filename);
  const lines = [];
  if (meta) {
    lines.push(`[録音日時] ${meta.recordedAt || stamp}`);
    if (meta.durationSec != null) lines.push(`[録音時間] ${Math.floor(meta.durationSec / 60)}分${Math.floor(meta.durationSec % 60)}秒`);
    if (meta.chunkCount != null) lines.push(`[チャンク数] ${meta.chunkCount}個 (${meta.successCount || 0}成功, ${meta.failCount || 0}失敗)`);
    lines.push("");
  }
  if (rawText) {
    lines.push("─── 生テキスト ───");
    lines.push(rawText);
    lines.push("");
  }
  if (cleanedText) {
    lines.push("─── AI整形済み ───");
    lines.push(cleanedText);
    lines.push("");
  }
  try {
    fs.writeFileSync(filepath, lines.join("\n"), "utf-8");
    console.log(`[Backup] saved: ${filepath}`);
    return filepath;
  } catch (e) {
    console.error("[Backup] write error:", e.message);
    return null;
  }
}

// 未処理の音声 (全チャンク失敗時など) を保存
function saveUnprocessedAudio({ stamp, audioBuffer, format }) {
  ensureDirs();
  const ext = format === "mp4" ? "m4a" : "webm";
  const filename = `${stamp}.${ext}`;
  const filepath = path.join(UNPROCESSED_DIR, filename);
  try {
    fs.writeFileSync(filepath, audioBuffer);
    console.log(`[Backup] unprocessed saved: ${filepath}`);
    return filepath;
  } catch (e) {
    console.error("[Backup] unprocessed write error:", e.message);
    return null;
  }
}

// 30日より古いバックアップを自動削除
function cleanupOldBackups() {
  ensureDirs();
  const cutoff = Date.now() - BACKUP_RETAIN_DAYS * 24 * 60 * 60 * 1000;
  for (const dir of [BACKUP_DIR, UNPROCESSED_DIR]) {
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const filepath = path.join(dir, file);
        try {
          const stat = fs.statSync(filepath);
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(filepath);
            console.log(`[Backup] cleanup: ${filepath}`);
          }
        } catch {}
      }
    } catch {}
  }
}

// 未処理の音声ファイル一覧を返す (起動時の再試行通知用)
function listUnprocessed() {
  ensureDirs();
  try {
    const files = fs.readdirSync(UNPROCESSED_DIR);
    return files
      .filter((f) => f.endsWith(".webm") || f.endsWith(".m4a"))
      .map((f) => ({
        name: f,
        path: path.join(UNPROCESSED_DIR, f),
        stamp: f.replace(/\.(webm|m4a)$/, ""),
      }));
  } catch {
    return [];
  }
}

// 未処理ファイルを削除（再処理成功後に呼ぶ）
function removeUnprocessed(filepath) {
  try {
    fs.unlinkSync(filepath);
    console.log(`[Backup] removed unprocessed: ${filepath}`);
  } catch (e) {
    console.error("[Backup] remove error:", e.message);
  }
}

module.exports = {
  BACKUP_DIR,
  UNPROCESSED_DIR,
  DOCUMENTS_DIR,
  ensureDirs,
  nowStamp,
  saveBackup,
  saveUnprocessedAudio,
  cleanupOldBackups,
  listUnprocessed,
  removeUnprocessed,
};
