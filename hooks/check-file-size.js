#!/usr/bin/env node
// PreToolUse gate for Read: blocks direct reads of large files, redirects to bulk-reader subagent.
const fs = require("fs");

const LINE_LIMIT = 350;
const BYTE_LIMIT = 40 * 1024; // catches minified/JSON/CSV files that are huge in bytes but short in lines

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  // PreToolUse fires for subagent tool calls too. Without this, bulk-reader's own
  // Read on the file it was dispatched to read gets denied by itself — a deny loop.
  if (payload?.agent_type === "bulk-reader") process.exit(0);

  const filePath = payload?.tool_input?.file_path;
  if (!filePath) process.exit(0);

  // Paginated read (offset/limit) for a slice at or under the threshold is already cheap — let it through.
  const requestedLimit = Number(payload?.tool_input?.limit);
  if (Number.isFinite(requestedLimit) && requestedLimit > 0 && requestedLimit <= LINE_LIMIT) {
    process.exit(0);
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    process.exit(0);
  }

  let reason;
  if (stat.size > BYTE_LIMIT) {
    reason = `File is ${Math.round(stat.size / 1024)}KB (limit ${Math.round(BYTE_LIMIT / 1024)}KB) — large in bytes even if short in lines (minified/JSON/CSV). To understand this file, invoke the Task tool with subagent_type: "bulk-reader" NOW — it's the first option, not the last. Do NOT reconstruct the content with repeated greps or searches: that pulls the file back into context and wastes tokens, which is exactly what delegation avoids. A targeted grep for ONE specific reference is fine; to map or summarize the file, delegate.`;
  } else {
    let lineCount;
    try {
      const content = fs.readFileSync(filePath, "utf8");
      lineCount = content.split("\n").length;
    } catch {
      process.exit(0);
    }
    if (lineCount <= LINE_LIMIT) process.exit(0);
    reason = `File has ${lineCount} lines (limit ${LINE_LIMIT}). To understand this file, invoke the Task tool with subagent_type: "bulk-reader" NOW — it's the first option, not the last. Do NOT reconstruct the content with repeated greps or searches: that pulls the file back into context and wastes tokens, which is exactly what delegation avoids. A targeted grep for ONE specific reference is fine; to map or summarize the file, delegate.`;
  }

  // Deny via JSON on stdout, not exit code: exit 2 also blocks and is documented as
  // redundant here, but the doc guidance is to pick one contract per hook, and the
  // hook's entire value is in permissionDecisionReason (the delegation instruction) —
  // JSON+exit 0 is the narrower surface if the contract changes later.
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
});
