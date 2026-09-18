// Disk memoization of bulk-reader summaries. Shared by check-file-size.js (read)
// and subagent-stop.js (write). Key: sha256(absolute path + mtimeMs + size).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Stay under Claude Code's 10,000-char additionalContext cap — past that, the
// host saves the text to a file and passes back only a path + preview, which
// defeats the point of a cache hit (no full summary reaches the model inline).
const MAX_ADDITIONAL_CONTEXT = 9500;

function cacheDir() {
  const base = process.env.CLAUDE_PLUGIN_DATA;
  if (!base) return null;
  return path.join(base, "bulk-reader-cache");
}

function cacheKey(absPath, stat) {
  return crypto.createHash("sha256").update(`${absPath}:${stat.mtimeMs}:${stat.size}`).digest("hex");
}

function cacheFile(filePath, stat) {
  const dir = cacheDir();
  if (!dir) return null;
  const absPath = path.resolve(filePath);
  return path.join(dir, `${cacheKey(absPath, stat)}.json`);
}

// Returns the cached summary string, or null on miss/stale/unreadable.
function readSummary(filePath, stat) {
  const file = cacheFile(filePath, stat);
  if (!file) return null;
  try {
    const entry = JSON.parse(fs.readFileSync(file, "utf8"));
    // Belt-and-suspenders: the hash already encodes mtime+size, but a hash
    // collision or a hand-edited cache file shouldn't serve a stale summary.
    if (entry.size === stat.size && entry.mtimeMs === stat.mtimeMs) return entry.summary;
  } catch {
    return null;
  }
  return null;
}

function writeSummary(filePath, stat, summary) {
  const dir = cacheDir();
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const absPath = path.resolve(filePath);
    const file = path.join(dir, `${cacheKey(absPath, stat)}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        filePath: absPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        summary,
        cachedAt: new Date().toISOString(),
      })
    );
  } catch {
    // Best-effort cache — a write failure must never break the subagent turn.
  }
}

module.exports = { readSummary, writeSummary, MAX_ADDITIONAL_CONTEXT };
