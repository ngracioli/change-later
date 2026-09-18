# Honest numbers

No claimed savings percentage yet — this file states the methodology, so the
claim, when it lands, is checkable.

## Why a single-read benchmark undercounts

A one-shot "read this file once, hook on vs. off" test only measures the
price-per-token difference between the main model and Haiku. It misses the
larger effect: in a multi-turn conversation, a file read directly stays in
the main context and gets re-sent on every following turn. A file read via
`bulk-reader` is read once, in a disposable context, and only the summary
persists. That second effect compounds with conversation length and is
expected to dominate the first for any task longer than a couple of turns.

## Methodology

- **Task, not single read.** Run a realistic multi-turn task (e.g. "find and
  fix a bug in this file, then explain the fix") twice: hook on, hook off.
- **Report main-model and worker tokens separately.** Don't collapse into one
  number — the main model's token count is what the user's plan/quota
  actually charges against; the worker's is a separate, usually cheaper,
  line.
- **Report a range by file profile, not one number.** A 1300-line TypeScript
  file, a 300-line file with a 200KB minified dependency, and a file read
  with small offset/limit slices behave differently under this hook. One
  aggregate percentage hides that.
- **State the plan type.** API (per-token) and subscription (Pro/Max) see
  different effective savings — the per-token price difference only shows up
  directly on API billing.

## Status

Not measured yet. This file will be replaced with real numbers, per the
methodology above, once a multi-turn benchmark has been run.
