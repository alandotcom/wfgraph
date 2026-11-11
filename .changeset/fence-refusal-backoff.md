---
"@wfgraph/core": patch
---

A run whose pass is refused by a version fence, because a Migration moved it, now waits one second before its next pass instead of running again at once, so a refusal that keeps recurring cannot hold a worker in a tight loop. The refusal still counts as no failure.
