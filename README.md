# context-offload

Plugin that **saves context** by delegating large-file reads to a worker running on **Haiku**, keeping the main model focused on reasoning, editing, and debugging.

The raw file never enters the main model's context — only a structured summary comes back. Inspired by [Spotify's shunt](https://github.com/spotify/portal-ai-plugins) and [caveman](https://github.com/JuliusBrussee/caveman)'s multi-agent organization, but built on Claude Code's **native** features: no API key, no external service, no ToS violation.

## The problem it solves

When the agent reads a large file, the raw content enters context and burns thousands of tokens on a task that barely needs reasoning. Core idea: **keep junk out of the expensive model's context.**

- **Context gain:** the raw file stays in the worker's isolated context, not in the main conversation. Real and native.
- **Quota gain:** two separate sources. (1) The file's tokens are read by Haiku, not the main model — price-per-token difference. (2) The file isn't reloaded into the main conversation on every following turn — this is usually the bigger source in a multi-turn task, and a single-read benchmark misses it entirely. Direct on API plans (per-token). On subscription (Pro/Max) the effect may be smaller — measure your own case (see `docs/HONEST-NUMBERS.md`).

## How it works

Three layers on top of Claude Code's native features:

1. **Hooks** (`PreToolUse`) — intercept before it costs anything. `Read` is a hard gate: line-count OR byte-size over threshold denies, regardless of the model, *unless* a valid disk-cache entry exists for that exact file state (see Disk cache below) — a hit is served inline, no denial, no delegation. Lockfiles and minified bundles get a much lower threshold, and files that look generated deny with a "grep instead, don't delegate" reason rather than the usual bulk-reader instruction (see Generated files and per-file-type thresholds). A small paginated `Read` (offset/limit at or under the threshold) is let through — it's already cheap. `cat`/`head`/`tail` in `Bash` is a *speed bump*, not a hard gate — see Design decisions.
2. **Subagent worker** (`model: haiku`) — reads in its own isolated context and returns only the summary. Runs under Claude Code's own auth, no key. Its summary is cached to disk on completion (`SubagentStop`).
3. **Skill / description** — makes the model delegate early, as the first option.

Validated in a real test (guard.ts, 1335 lines): the hook blocked, Claude delegated on the first try, and the summary came back useful, without the raw file touching main context.

## Parallel dispatch

Spotify's shunt runs the Portal CLI in a blocking Bash call — 10–30s
per delegation, and mapping N large files costs N × that, serialized.

Native subagents fix this differently: in an **interactive session**,
subagent dispatch runs in background by default (fork mode) — the same
per-file latency stops blocking the session, and multiple `bulk-reader`
Task calls in one turn run concurrently (cap: 20 concurrent subagents per
session), so mapping 5 large files costs one delegation's wall time, not
five. `skills/delegation/SKILL.md` tells the main model to dispatch one
worker per file in a single turn instead of looping sequentially, and each
worker's summary opens with the file path it read so N concurrent results
don't come back indistinguishable.

**Caveat:** this depends on fork mode being on, which is an interactive-session
default. In **non-interactive `-p` mode and the Agent SDK, fork mode is off
by default** — subagent calls there block sequentially, so parallel
dispatch still saves tokens (Haiku, isolated context) but not wall-clock
time, same as Spotify's shunt.

## Multi-agent organization

Follows the caveman pattern: **one install entry point per agent at the root, shared content in agent-agnostic folders.** What changes between agents is the install, not the content.

```
context-offload/
├── .claude-plugin/               # Claude Code ENTRY POINT
│   ├── marketplace.json          #   catalog
│   └── plugin.json               #   manifest
├── agents/                       # SHARED: subagents
│   └── bulk-reader.md            #   worker (model:haiku, read-only)
├── skills/                       # SHARED: skills
│   └── delegation/SKILL.md       #   when to delegate
├── hooks/                        # Claude-specific (PreToolUse/SubagentStop contract)
│   ├── hooks.json
│   ├── check-file-size.js        #   gate for Read (cross-platform, Node), cache lookup
│   ├── check-bash-read.js        #   gate for cat/head/tail via Bash
│   ├── subagent-stop.js          #   writes bulk-reader's summary to the disk cache
│   └── lib/
│       ├── cache.js              #   shared disk-cache read/write
│       ├── limits.js             #   per-file-type line/byte thresholds
│       └── generated.js          #   generated-file marker detection
├── evals/                        # claude plugin eval suite (see Eval suite)
├── .github/workflows/ci.yml      # validate + eval, gates PRs
├── docs/
│   └── HONEST-NUMBERS.md         #   real measurement of the savings
└── README.md
```

**How each agent plugs in:**
- **Claude Code (today):** `.claude-plugin/` + `hooks/` + `agents/` + `skills/`
- **Codex (future):** add `.codex/` or `AGENTS.md`, reusing `agents/` and `skills/`
- **Cursor/others (future):** own entry point at the root, same shared content

Only the **hook** is tightly bound to Claude Code (`PreToolUse` contract). Subagents and skills are concepts that re-express per agent; the delegation logic stays the same.

## Design decisions

- **LSP checked before delegation when available.** `skills/delegation/SKILL.md` prefers the LSP tool (go-to-definition, find references, document symbols) over spawning `bulk-reader` when the question is about definitions/references/types/symbols rather than prose or logic — zero content loaded into context, millisecond latency vs 10-30s for a subagent. Requires a code-intelligence plugin installed for the language (official ones: `pyright-lsp`, `typescript-lsp`, `rust-analyzer-lsp`); doesn't run in cloud sessions. Falls back to delegation automatically and silently when unavailable.
- **Delegation is the first half of a read-then-edit flow, not a dead end — this is what resolves the read-before-edit tension.** `Edit` requires Claude Code to have read the target file in-conversation, and a gate-denied attempt (the `PARTIAL view` warning on a bulk `Read`) doesn't count as having read it. Jumping straight from a `bulk-reader` summary to `Edit` hits that same wall. The fix: `bulk-reader`'s contract requires every `Structure`/`Answer` entry to carry a full `start-end` line range, never a bare start line (`agents/bulk-reader.md`) — the natural next step is a `Read` with `offset`/`limit` set to that exact range, kept at or under the size threshold, which the gate already lets through (see "Explicit `offset` bypasses the size gate" below) without denial or re-delegation. `skills/delegation/SKILL.md` spells out this second step explicitly, so delegation isn't terminal: question → delegate → paginated `Read` on the returned range → `Edit`, all without the full file ever entering context. Verified end-to-end: a synthetic 601-line file gets denied on a bare `Read`, then allowed silently on `Read(offset: 42, limit: 77)` matching a returned range.
- **Worker reused across follow-ups on the same file, not respawned.** Spotify's shunt re-sends the whole file to the cheap model on every follow-up question — its stated limitation. Here, a `bulk-reader` that already read a file can be resumed with `SendMessage` (agent ID/name), keeping full history; the resumed run still reads from the prompt cache the first run warmed. First question pays for the read, later ones on that file are near-cache-hit, at zero raw-content cost to the main context. `skills/delegation/SKILL.md` tells the main model to check for a matching worker before spawning a new one — instruction, not a hook-enforced gate. `experimental.cacheTtl: "1h"` on the worker (requires Claude Code ≥ 2.1.248) keeps that cache warm long enough to matter across a multi-turn task.
- **Worker = native Haiku subagent.** No key, no external service, within ToS. Isolated context is native.
- **Haiku scoped to the worker.** Doesn't force a model for the rest of the session.
- **`omitClaudeMd: true` on the worker.** The whole point is a disposable context — no reason to also load the CLAUDE.md hierarchy and git status into it. Requires Claude Code ≥ 2.1.271. **Minimum supported Claude Code version: 2.1.271** (also required by the hook contract choices above; developed/tested on 2.1.277).
- **Hook in the plugin's `hooks/hooks.json`**, not in the subagent frontmatter — plugins ignore `hooks`/`mcpServers`/`permissionMode` in frontmatter.
- **Hook in Node**, single file, cross-platform (Windows/Linux/Mac) — Claude Code already ships Node.
- **`bulk-reader` is exempt from its own gate.** `PreToolUse` fires for subagent tool calls too, not just the main agent — without this, the worker's own `Read` on the file it was dispatched to read would deny itself (deny loop). Tested end-to-end with `--plugin-dir` + `--debug` against a real 1334-line file: the payload's `agent_type` is plugin-prefixed (`"context-offload:bulk-reader"`, not `"bulk-reader"`) — an exact-match check silently never fires. The check compares the last `:`-segment instead. Caught this by dumping the real hook payload, not from docs — worth remembering if the exemption ever needs touching again.
- **Explicit `offset` bypasses the size gate on `Read`.** Once the caller knows where to look (after a `bulk-reader` summary, or mid-edit), a paginated read with an explicit `offset` is a targeted read, not a bulk one — let it through regardless of size/limit. Verified end-to-end: `bulk-reader` locates a function, the main agent does a small `Read(offset, limit)` itself, then `Edit` — zero denials, no forced re-delegation for what's already a cheap read.
- **Hook contract: `permissionDecision: "deny"` JSON on stdout + `exit 0`**, not `exit 2`. Claude Code reads the JSON at any exit code, and `exit 2` also blocks — the two aren't mutually exclusive, but the guidance is to pick one contract per hook. The hook's entire value is in `permissionDecisionReason` (the delegation instruction), so JSON+`exit 0` is the narrower surface if the contract changes later.
- **Bash gate is a speed bump, not a hard gate.** It only catches `cat`/`head`/`tail`. Readers like `sed`, `awk`, `less`, `jq`, `python -c`, `git show`, shell redirects, or a quoted/nested command all slip through, and enumerating every reader is a losing game — the only real hard gate is `Read`. `PostToolUse` isn't a fix either: by the time it fires the content is already in context. So the Bash gate is honestly a nudge for the common case, not a guarantee.
- **Bash gate uses `if` matchers, not a blanket `Bash` spawn.** Three hook entries, one per command (`Bash(cat *)`, `Bash(head *)`, `Bash(tail *)`), so a non-matching Bash call (`ls`, `grep`, ...) never spawns Node at all — confirmed in `--debug` output ("Skipping hook due to if condition ... not matching"). Matches the speed-bump framing: filter cheaply, don't run a process per Bash call.
- **Hook commands use exec form** (`command`/`args` array, not a single shell-tokenized string) plus `statusMessage` — avoids Windows quoting/tokenization issues.
- **Honest numbers.** Measure your own setup's real savings before claiming any percentage (a lesson straight from caveman).

### Disk cache

The gate now memoizes bulk-reader's summaries to disk, so a repeat question about
a file that hasn't changed since the last summary skips delegation entirely —
served in milliseconds, no worker spawn, no model call.

- **Storage: `${CLAUDE_PLUGIN_DATA}`, not `${CLAUDE_PLUGIN_ROOT}`.** `CLAUDE_PLUGIN_ROOT`
  points at the installed plugin's own code directory, which is replaced wholesale
  on every update — anything written there is gone on the next `claude plugin update`.
  `CLAUDE_PLUGIN_DATA` is the plugin's persistent data directory, survives updates,
  and is the correct place for anything the plugin generates at runtime rather than
  ships with.
- **Key: `sha256(absolute path + mtimeMs + size)`.** `check-file-size.js` already
  calls `statSync` on the byte-size fast path, so reusing that same stat for the
  cache lookup is near-zero marginal cost — no extra syscall on the hot path.
- **Invalidation: mtime+size, not a content hash.** A content hash is stronger
  (catches a same-size same-mtime edit, which mtime+size can't) but requires
  reading the whole file to invalidate the cache — exactly the I/O this cache
  exists to avoid paying on every gate check. mtime+size is what the OS already
  tracks for free via `stat`, and it's the same signal build tools (`make`, most
  bundlers) trust for "did this file change" — good enough here, and the failure
  mode (a same-size edit within the same filesystem-timestamp tick) is rare
  enough not to justify reading every large file on every check just to rule it
  out. If that gap ever matters, the fix is a content hash gated *behind* the
  mtime+size check (only hash on a size/mtime match), not instead of it.
- **Cache entries never expire on their own.** There's no TTL — a hit is valid
  for as long as mtime+size hasn't changed, which is the correctness condition
  the cache actually cares about. Nothing currently prunes stale entries for
  files that get deleted or renamed; they just sit unused in
  `${CLAUDE_PLUGIN_DATA}/bulk-reader-cache/`. Acceptable for a POC — one JSON
  file per unique (path, mtime, size) tuple, and the whole directory can be
  wiped safely at any time (it's a cache, not state).
- **Write path: `SubagentStop` matched on `agent_type`.** Same plugin-prefix
  gotcha as the `Read`/`Bash` gates (`"context-offload:bulk-reader"`, not
  `"bulk-reader"`) — filtered in-script rather than via the hook's `matcher`,
  for the same reason: matching a prefixed field with a plain-string matcher is
  unreliable, so every hook here does the agent-type check as its first line
  instead. The hook reads `last_assistant_message` straight off the
  `SubagentStop` payload for the summary text (no transcript parsing needed for
  that part) and finds the target file by scanning `agent_transcript_path` for
  bulk-reader's own first `Read` tool call — more reliable than trying to parse
  a file path back out of free-form summary prose.
- **`additionalContext` has a ~10,000-char budget.** Past that, Claude Code
  saves the text to a file and only passes back a path + preview to the model —
  which would silently defeat a cache hit's whole purpose (the point is the
  full summary reaching the model inline, not a preview snippet). The hook
  caps what it emits at 9,500 chars and appends a note if a cached summary is
  longer, rather than relying on undocumented host-side truncation behavior.
  In practice this shouldn't fire often: bulk-reader's contract is a compact
  structured summary, not raw code.

### Generated files and per-file-type thresholds

Some large files are large on purpose and nobody — human or model — is meant
to read them top to bottom: lockfiles, generated clients, minified bundles,
snapshots. Delegating one of those to `bulk-reader` burns a 10-30s
subagent turn to produce a summary nobody asked for, when what the caller
actually needed was one grep hit.

- **Generated-file markers** (`hooks/lib/generated.js`): the first 20 lines
  (or first 4KB, on the byte-size fast path where the full file is never
  read) are checked against:
  - `@generated`
  - `DO NOT EDIT`
  - `Code generated by`
  A match still denies the read, but with a different
  `permissionDecisionReason`: use a targeted `Grep` for the specific
  symbol/string instead of delegating to `bulk-reader` at all. This is
  checked on both `check-file-size.js` (`Read`) and `check-bash-read.js`
  (`cat`/`head`/`tail`), reusing whatever content each hook already read for
  its line count — the byte-size fast path is the only case that pays for an
  extra (capped, 4KB) read.
  **Heuristic, not proof.** These markers cover the common codegen
  conventions (`protoc`, Go's `//go:generate`, GraphQL codegen, etc.) but a
  hand-written file that happens to contain one of these strings in a
  comment (documenting the convention, say) will false-positive into the
  "don't delegate" path. The cost of a false positive is a wrong
  *suggestion* in the deny reason, not a wrong *decision* — the read is
  still denied either way, so the model still needs a plan; worst case it
  greps instead of delegating and finds nothing, then falls back to
  delegating anyway.
- **Per-file-type thresholds** (`hooks/lib/limits.js`): lockfiles
  (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `composer.lock`,
  `Cargo.lock`, `Gemfile.lock`, `poetry.lock`, `Pipfile.lock`, `mix.lock`,
  `go.sum`) and minified bundles (`*.min.js`, `*.min.css`) get a much lower
  bar — 40 lines / 4KB instead of the default 350 lines / 40KB — matched by
  basename or suffix before the general threshold applies. Rationale: a
  40-line source file is normal; a 40-line lockfile is already more than
  anyone needs to see inline. This is deliberately not tied to the
  generated-marker check above — a small lockfile with no marker still gets
  gated at the low threshold, and a large marked-generated file still gets
  the low-threshold bar too if it also matches a lockfile/minified pattern.

## Eval suite

`evals/` has 4 cases exercising the `Read` gate: `mass-read` (>350 lines,
expects delegation), `paginated-read` (small offset/limit slice, expects
direct read), `small-file` (<350 lines, expects direct read), and
`minified-file` (1 line but ~47KB, expects delegation via the byte-size
fast path). Each case seeds its own fixture with a `scaffold_script`
(`context.scaffold_script` in `case.yaml`) — eval runs start in an empty,
isolated workspace with no access to the repo, so the fixture has to be
generated at run time, not checked in.

```
claude plugin eval . --trust-plugin --scaffold \
  --json evals/results/run.json --threshold 0.8 \
  --model claude-sonnet-5 --judge-model claude-haiku-4-5 --no-publish
```

`--scaffold` is required (off by default, since it runs author-supplied
bash) — every case here needs it to create its fixture. `--trust-plugin`
skips the interactive trust prompt (needed for CI / non-TTY).

Check the plugin's always-on cost too — what it charges every session even
when the gate never fires: `claude plugin details context-offload`.

## CI

`.github/workflows/ci.yml` runs on every push/PR to `main`:

1. `claude plugin validate ./ --strict` — manifest/schema errors.
2. `claude plugin eval . --trust-plugin --scaffold --threshold 0.8 --model claude-sonnet-5 --judge-model claude-haiku-4-5 --no-publish --max-cost-usd 20` — the eval suite above, gated at 0.8.

Both the agent model and the judge model are pinned explicitly. Without
that, a model rollout on Anthropic's side would look like a regression in
this plugin instead of what it actually is.

## Install (Claude Code)

```
claude plugin marketplace add <your-username>/context-offload
claude plugin install context-offload@context-offload
```

Restart Claude Code after installing — subagents and hooks are read at session boot.

## Status

✅ Proof of concept validated (hook + subagent + delegation working end to end, including the subagent deny-loop and paginated-edit paths — see Design decisions).
✅ Eval suite (`evals/`) + CI gate wired up.
❌ **No separate packaging step.** Caveman needs `plugins/<name>/` because its repo root holds more than one plugin's worth of stuff; this repo's root already *is* a valid plugin (`.claude-plugin/` + `agents/` + `skills/` + `hooks/` at the root, nothing else competing for that space), so `claude plugin marketplace add` + `claude plugin install` install directly from it. Decided, not pending.
