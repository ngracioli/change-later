#!/usr/bin/env node
// PreToolUse gate for Bash: blocks cat/head/tail on large files, redirects to bulk-reader subagent.
const fs = require("fs");

const LINE_LIMIT = 350;
const READ_CMDS = /^(cat|head|tail)\b/;

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  // PreToolUse fires for subagent tool calls too — exempt bulk-reader itself.
  // agent_type is plugin-prefixed ("<plugin-name>:bulk-reader"), see check-file-size.js.
  if (payload?.agent_type?.split(":").pop() === "bulk-reader") process.exit(0);

  const command = payload?.tool_input?.command;
  if (!command) process.exit(0);

  // ponytail: naive per-segment split on &&/;/|, no full shell parsing. Upgrade if quoted/nested commands slip through.
  const segments = command.split(/&&|;|\|/).map((s) => s.trim());
  const filePath = segments
    .filter((s) => READ_CMDS.test(s))
    .map((s) => s.split(/\s+/).filter((t) => !t.startsWith("-")).pop())
    .find(Boolean);

  if (!filePath) process.exit(0);

  let lineCount;
  try {
    const content = fs.readFileSync(filePath, "utf8");
    lineCount = content.split("\n").length;
  } catch {
    process.exit(0);
  }

  if (lineCount <= LINE_LIMIT) process.exit(0);

  const reason = `File has ${lineCount} lines (limit ${LINE_LIMIT}). To understand this file, invoke the Task tool with subagent_type: "bulk-reader" NOW — it's the first option, not the last. Do NOT reconstruct the content with repeated cat/head/tail or greps: that pulls the file back into context and wastes tokens, which is exactly what delegation avoids. A targeted grep for ONE specific reference is fine; to map or summarize the file, delegate.`;
  // Deny via JSON on stdout, not exit code — see check-file-size.js for why.
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
