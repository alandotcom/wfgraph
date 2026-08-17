---
"@wfgraph/client": patch
---

Order a loaded Group graph rest → frames → members so the canvas can reuse the
store array instead of reallocating on every read.
