---
"@wfgraph/core": patch
---

Effect, `@effect/vitest` and `@effect/opentelemetry` move from `4.0.0-rc.108` to
`4.0.0-rc.109`. An adopter installing `@wfgraph/core` or `@wfgraph/plugins` resolves the
newer release candidate. The RC is a patch: inference for `Effect.fromOption`, typed
`SqlError` on a failed `BEGIN`, and documentation. Nothing Workflow Graph calls changed.
