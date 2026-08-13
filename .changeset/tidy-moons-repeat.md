---
"@wfgraph/core": minor
---

Effect moves to the 4.0 release candidate.

`effect`, `@effect/vitest` and `@effect/opentelemetry` go from `4.0.0-beta.102` to
`4.0.0-rc.108`, so an adopter installing `@wfgraph/core` or `@wfgraph/plugins` resolves the
release candidate. Upstream treats the 4.0 interfaces as final from this version on.

Two upstream changes are visible here. `Schema.TaggedErrorClass` is now `Schema.TaggedError`,
which is how every failure type in the backend is declared. Separately, a `SchemaIssue` has
stopped carrying the value a decode rejected, and holds it only when the decode asks with
`reportInput`. Workflow Graph asks nowhere, so a message about a refused step config, Event
payload, step output or workflow graph ends after the field path and the expectation. Where
one read `to: Expected string, got 7`, it now reads `to: Expected string`.

`formatSchemaFailurePaths` is gone from `@wfgraph/shared`. `formatSchemaFailure` renders
what it used to render, so one function now covers both audiences.

A failed check keeps the bound Effect names for it, so `name: Invalid value` reads
`name: Expected a value with a length of at least 1`.
