---
"@wfgraph/core": patch
---

Bound webhook request bodies before a Connection lookup. A body over 1 MiB now receives a 413 response rather than being buffered.
