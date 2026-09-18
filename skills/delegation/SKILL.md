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

Invoke the Task tool with `subagent_type: "bulk-reader"`, passing the file
path (and the question, if any). It reads in its own isolated context
and returns only: structure, answer (if there was a question), and
relevant notes. The raw content never enters the main context.

Don't try to reconstruct the file's content with repeated
greps/searches — that brings the file back into context and cancels
out the gain from delegation.
