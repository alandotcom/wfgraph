---
"@wfgraph/core": minor
---

The authoring tool `list_references` takes `nodeIds`, a list of steps, in place of `nodeId`, and answers for all of them in one call. A reference every named step can read carries no `readableBy`; a reference only some can read lists those steps in `readableBy`. An MCP client that sends `nodeId` must send `nodeIds`.
