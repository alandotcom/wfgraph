---
"@wfgraph/core": patch
---

Bump the Effect v4 release candidate from 4.0.0-rc.111 to 4.0.0-rc.113, along with `@effect/vitest`, `@effect/opentelemetry`, `@effect/sql-sqlite-node` and `@effect/ai-openai`, which each name that exact core version as a peer.

The release adds a `StandardSchema` module to `effect`, holding the Standard Schema specification's type declarations vendored from `@standard-schema/spec`. `@wfgraph/shared`'s `toStandardSchema` stays the bridge this repo crosses, because it bakes in the decode options a wire schema needs.

The build agent now uses Effect AI's renamed Chat type and opaque streamed tool parameters. Linear error decoding uses open schemas after Effect removed the decode option that preserved excess properties. The main suite now runs on Vitest 5 as required by `@effect/vitest`; the private eval harness keeps an isolated Vitest 4 runner for `vitest-evals`.

Raise the Hono peer floor to 4.13.7, which fixes the server-side JSX escaping advisory GHSA-hxh3-vqpv-xpqv, and update Inngest to 4.20.0. Refresh the repository's compatible development dependencies alongside them.
