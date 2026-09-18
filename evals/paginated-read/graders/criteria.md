---
type: llm
weight: 1
---

A successful response answers correctly (`fn2`) and does so cheaply: a
50-line paginated read is well under the 350-line delegation threshold, so
delegating to a subagent here would be wasted latency, not a requirement.
