#!/usr/bin/env node
// SubagentStop hook: caches bulk-reader's summary on disk, keyed on the target
// file's path+mtime+size, so a repeat question about an unchanged file skips
// delegation entirely (see check-file-size.js).
const fs = require("fs");
const { writeSummary } = require("./lib/cache");

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  // agent_type is plugin-prefixed ("<plugin-name>:bulk-reader"), same as the
  // Read/Bash gates — matcher can't reliably match the prefix, so filter here.
  if (payload?.agent_type?.split(":").pop() !== "bulk-reader") process.exit(0);

  const summary = payload?.last_assistant_message;
  const transcriptPath = payload?.agent_transcript_path;
  if (!summary || !transcriptPath) process.exit(0);

  const filePath = firstReadTarget(transcriptPath);
  if (!filePath) process.exit(0);

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    process.exit(0);
  }

  writeSummary(filePath, stat, summary);
  process.exit(0);
});

// bulk-reader is dispatched with a single target file; its own first Read call
// (exempted from the gate) names that file. Scanning the transcript for it is
// more reliable than parsing the file path out of free-form summary text.
function firstReadTarget(transcriptPath) {
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, "utf8").split("\n");
  } catch {
    return null;
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use" && block?.name === "Read" && block?.input?.file_path) {
        return block.input.file_path;
      }
    }
  }
  return null;
}
