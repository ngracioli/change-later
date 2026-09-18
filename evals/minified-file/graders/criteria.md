---
type: llm
weight: 1
---

A successful response gives a reasonable count (~500) without the raw JSON
blob showing up pasted in the visible conversation. The file is one line
(so the line-count gate alone wouldn't catch it) but ~47KB, over the
40KB byte-size threshold meant exactly for this profile — minified/JSON/CSV
files that are huge in bytes but short in lines.
