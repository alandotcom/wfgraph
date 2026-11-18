---
"@wfgraph/core": patch
"@wfgraph/plugins": patch
---

`@wfgraph/core` and `@wfgraph/plugins` now depend on `effect` 4.1.4, and `@wfgraph/core` depends on `@effect/ai-anthropic`, `@effect/ai-openai`, `@effect/ai-openai-compat`, `@effect/ai-openrouter`, `@effect/opentelemetry` and `@effect/sql-sqlite-node` 4.1.4. A host that installs its own copy of `effect` should move it to 4.1.4 so the host and Workflow Graph share one copy.
