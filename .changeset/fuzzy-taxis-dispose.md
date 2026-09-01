---
"@wfgraph/core": minor
---

Add standard asynchronous disposal to `WfGraphApp`, so lexically scoped apps can use
`await using` while long-running hosts retain the explicit `dispose()` API.
