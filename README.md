# context-offload

Plugin that **saves context** by delegating large-file reads to a worker running on **Haiku**, keeping the main model focused on reasoning, editing, and debugging.

The raw file never enters the main model's context — only a structured summary comes back. Inspired by [Spotify's shunt](https://github.com/spotify/portal-ai-plugins) and [caveman](https://github.com/JuliusBrussee/caveman)'s multi-agent organization, but built on Claude Code's **native** features: no API key, no external service, no ToS violation.

## The problem it solves

When the agent reads a large file, the raw content enters context and burns thousands of tokens on a task that barely needs reasoning. Core idea: **keep junk out of the expensive model's context.**

- **Context gain:** the raw file stays in the worker's isolated context, not in the main conversation. Real and native.
- **Quota gain:** two separate sources. (1) The file's tokens are read by Haiku, not the main model — price-per-token difference. (2) The file isn't reloaded into the main conversation on every following turn — this is usually the bigger source in a multi-turn task, and a single-read benchmark misses it entirely. Direct on API plans (per-token). On subscription (Pro/Max) the effect may be smaller — measure your own case (see `docs/HONEST-NUMBERS.md`).

## How it works

Three layers on top of Claude Code's native features:

1. **Hooks** (`PreToolUse`) — intercept before it costs anything. `Read` is a hard gate: line-count OR byte-size over threshold denies, regardless of the model. A small paginated `Read` (offset/limit at or under the threshold) is let through — it's already cheap. `cat`/`head`/`tail` in `Bash` is a *speed bump*, not a hard gate — see Design decisions.
2. **Subagent worker** (`model: haiku`) — reads in its own isolated context and returns only the summary. Runs under Claude Code's own auth, no key.
3. **Skill / description** — makes the model delegate early, as the first option.

Validated in a real test (guard.ts, 1335 lines): the hook blocked, Claude delegated on the first try, and the summary came back useful, without the raw file touching main context.

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
├── hooks/                        # Claude-specific (PreToolUse contract)
│   ├── hooks.json
│   ├── check-file-size.js        #   gate for Read (cross-platform, Node)
│   └── check-bash-read.js        #   gate for cat/head/tail via Bash
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
