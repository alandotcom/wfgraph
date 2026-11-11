---
"@wfgraph/core": patch
---

A missing or malformed `encryption.key` now names the function the host called: `createWfGraphRunner` and `wfWorker` refuse it in their own name, where both used to name `createWfGraphApp`.
