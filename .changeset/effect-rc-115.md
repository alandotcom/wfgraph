---
"@wfgraph/core": patch
---

Bump the Effect v4 release candidate from 4.0.0-rc.113 to 4.0.0-rc.115, along with `@effect/vitest`, `@effect/opentelemetry`, `@effect/sql-sqlite-node`, and `@effect/ai-openai`, which each name that exact core version as a peer.

The two releases between rc.113 and rc.115 ship bug fixes: corrected published type declarations, a schema-generation fix for struct fields named `__proto__`, and an HTTP response fix for status codes 204, 205, and 304. rc.114 renames `Schema.Annotations.ToArbitrary.Constraint` to `Schema.Annotations.ToArbitrary.FilterConstraint`; this repository does not reference that name. This repository needed no other changes for the bump.
