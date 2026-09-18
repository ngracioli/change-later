---
name: delegation
description: >-
  Delegate reading large files (>350 lines) to the bulk-reader
  subagent instead of reading them directly or reconstructing them
  with greps. Use proactively as the first option, not the last,
  whenever you need to understand, map, or summarize a large file.
---

Large file = expensive context. Reading it directly burns tokens on a
task that barely needs the main model's reasoning.

## Precedence: LSP before delegation

Some questions are answered by code intelligence (LSP) with zero content loaded into context — milliseconds vs 10-30s for a subagent. Check LSP first for:

- Where is X defined? (go-to-definition)
- Who calls/references this? (find references)
- What are the types here?
- What symbols exist in this file? (document symbols)

Delegate to `bulk-reader` only when the question needs reading prose/logic, not just symbol structure — e.g. "what does this function actually do", "summarize this file's logic", "is this thread-safe".

The LSP tool is inactive until the user installs a code-intelligence plugin for the language, and doesn't run in cloud sessions. When unavailable, fall back to delegation automatically and silently — don't ask the user or mention the fallback.

## When to delegate

- You need to understand, map, or summarize a large file (>350 lines).
- You need to answer a specific question about a large file.

## When NOT to delegate

- A targeted grep for ONE specific reference — fine to do directly.
- The file is already within the limit — read it normally.

## When NOT to delegate, even if the hook denies (risk, not cost)

`bulk-reader` (Haiku) is good at structure and lookup, not judgment. If the
task is any of these, read the file yourself — do not trust a worker
summary for it, even though it costs more tokens:

- Concurrency / thread-safety review.
- Security-sensitive logic (auth, input validation, crypto, secrets handling).
- Subtle or non-obvious business logic you need to reason about correctly.
- An architectural decision that depends on the file's actual contents.

These come back "confident and wrong" more easily than they come back
"unhelpful" — the failure is silent. A worker summary is fine for "what's in
this file"; it is not a substitute for your own read when being wrong is
the expensive outcome.

## How to delegate

Check first: is there already a `bulk-reader` in this session that read
this same file? Its first response line names the file it read. If yes,
send it a follow-up message instead of spawning a new one — it keeps the
full conversation history, and the resumed run still reads from the prompt
cache the original run warmed. The first question pays for the read; every
later question on that file is close to a cache hit, at zero raw-content
cost to the main context.

If no matching worker exists yet, invoke the Task tool with
`subagent_type: "bulk-reader"`, passing the file path (and the question, if
any). It reads in its own isolated context and returns only: structure,
answer (if there was a question), and relevant notes. The raw content never
enters the main context.

Don't try to reconstruct the file's content with repeated
greps/searches — that brings the file back into context and cancels
out the gain from delegation.

This reuse step is an instruction, not a gate — hooks can't force it, so
follow it deliberately rather than defaulting to a fresh spawn.

## Next step: editing after delegation

Delegation isn't terminal — it's the first half of a cheap read-then-edit
flow. `bulk-reader` always returns `file:start-end` ranges, never a bare
line number. To edit, don't re-read the whole file and don't trust the
summary as a substitute for having seen the lines yourself:

1. `Read` with `offset`/`limit` set to the returned range (kept at or under
   the size threshold). This is a paginated read with an explicit offset —
   it passes the gate directly, no denial, no re-delegation.
2. `Edit` on what that Read shows you.

This is also what makes read-before-edit work with a large file: editing
requires having read the file in-conversation, and a gate-denied attempt
(the `PARTIAL view` warning) doesn't count as having read it. Going straight
from a `bulk-reader` summary to `Edit`, skipping the Read, hits that same
wall. The offset/limit Read on the returned range is what satisfies
read-before-edit cheaply, without ever pulling the full file into context.

## Multiple large files: dispatch in parallel, not sequentially

Understanding N large files → one `bulk-reader` per file, dispatched
together (multiple Task calls in the same turn), not one after another.
Interactive session runs subagents in background by default, so wall time
is one delegation's latency, not N of them (cap: 20 concurrent subagents
per session).

Every worker's first response line names the file it read — required for
reuse-checking above, and also what keeps N concurrent results from
landing back in context indistinguishable from each other.

In `-p` (non-interactive/print mode) and the Agent SDK, background
subagents are off by default — parallel dispatch there still saves
tokens (Haiku, isolated context) but not wall-clock time.
