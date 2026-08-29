---
"@wfgraph/core": patch
---

Bump the Effect v4 release candidate from 4.0.0-rc.111 to 4.0.0-rc.112, along with `@effect/vitest`, `@effect/opentelemetry` and `@effect/ai-openai`, which each name that exact core version as a peer. Nothing this package calls changed shape, so the upgrade is the version numbers alone.

The release adds a `StandardSchema` module to `effect`, holding the Standard Schema specification's type declarations vendored from `@standard-schema/spec`. `@wfgraph/shared`'s `toStandardSchema` stays the bridge this repo crosses, because it bakes in the decode options a wire schema needs.
