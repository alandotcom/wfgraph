---
"@wfgraph/core": patch
"@wfgraph/plugins": patch
---

`@wfgraph/core` and `@wfgraph/plugins` now depend on `effect` 4.1.3, and `@wfgraph/core` depends on `@effect/ai-openai`, `@effect/opentelemetry` and `@effect/sql-sqlite-node` 4.1.3. A host that installs its own copy of `effect` should move it to 4.1.3 so the host and Workflow Graph share one copy.
