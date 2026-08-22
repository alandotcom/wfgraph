---
"@wfgraph/client": patch
---

Restore a run's pinned graph and running animation after navigating back to it. A same-workflow hydrate was clearing the overlay without overlay sync noticing, so the canvas stayed on the draft while the Runs panel still showed the open run.
