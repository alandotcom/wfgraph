---
"@wfgraph/core": patch
---

A worker that dies while a run's steps run side by side, or just after a step finished, now counts against the run's own retries. Before, the expired lease was charged to whichever parallel step started first, or to a step that had already succeeded, which counted it against nothing.
