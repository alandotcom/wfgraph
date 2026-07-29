# Adopt Effect v4 beta across the backend, with a Promise seam at the embedder surfaces

_Decided 2026-07-27 by Alan Cohen, following an architecture review._

The backend has grown a separate answer for each of error handling, validation, and
dependency wiring. Failures travel as a `ServiceResult` kind that every caller re-inspects,
validation runs through Zod at some boundaries and hand-written checks at others, and a
service reaches its database handle and its Inngest client through process globals. Effect
covers all of that ground with one typed model, so we
adopt `effect@beta` (the v4 line, `4.0.0-beta.102` at the time of the decision) across
`@rova/core`, `@rova/plugins`, and the server-side code in `@rova/shared`. The version is
pinned exactly, and every `@effect/*` package is held at a version-aligned release,
because a beta line moves under you otherwise.

We took the beta over `effect` 3.22 stable. The repo is pre-release: its data is
disposable, its consumers are all inside this tree, and AGENTS.md rules out compatibility
shims, so the usual reason to prefer a stable line (protecting what already ships on it)
carries no weight here. Choosing v3 would
buy a whole-backend v3-to-v4 migration a few months from now, and the Effect-TS skill
guidance at github.com/Effect-TS/skills that will steer day-to-day work here is written
against v4 idioms.

## Where Effect stops

Everything an embedder touches stays Promise-based: the `createRovaApp` options object,
the fetch handler it returns, `@rova/core/node`, and all of `@rova/client`. An embedder
should be able to mount Rova in an Express app without learning Effect.

`@rova/core/plugin` is the deliberate exception and becomes Effect-native. A step handler
returns an `Effect` with tagged errors, and a `defineStep` constructor owns credential
fetch, step logging, and construction of the result envelope. Plugins are where Effect
pays for itself, since most of a plugin's body is a vendor HTTP call with a retry policy
around it and a decode of what came back. A Promise contract there would leave the
built-in plugins writing Effect internally and unwrapping it at the boundary, making them
second-class citizens of the surface they define.

## Schema

Effect Schema replaces Zod everywhere, including the RPC contracts in `@rova/shared`, the
timestamp codec, and `JsonValue` parsing. Service failures become tagged errors built with
`Schema.TaggedErrorClass`. The two adapters at the edges keep doing their translation job:
`packages/core/src/backend/rpc/errors.ts` maps a failure to an oRPC code, and
`packages/core/src/backend/lib/http/failure-response.ts` maps it to an HTTP status.
Knowledge of status codes stays at those two edges, exactly where it lives today.

oRPC moves to the 2.x beta together with `@orpc/experimental-effect`, which lets a
contract take Effect Schema directly, gives Effect-native handlers, and generates the
OpenAPI document from Effect schemas.

**Amendment, 2026-07-28.** Stage 4 landed as written, with one correction and one
addition. The correction: a contract's schemas cross into oRPC through the repo's own
`toStandardSchema` in `packages/shared/src/types/schema.ts`, not through the one
`@orpc/experimental-effect` exports. Effect has no per-schema `.strict()`, so a closed
object is closed only because the decode was told to close it, and oRPC calls
`~standard.validate(payload)` with no options — leaving the parse options as the only
place strictness can live, and oRPC's wrapper takes none. Both wrappers leave the schema
being an Effect schema, which is all `EffectSchemaToJsonSchemaConverter` needs, and that
converter did replace `ZodToJsonSchemaConverter` in
`packages/core/src/backend/rpc/openapi.ts` as this section says. The bridge is not part of
the plugin surface either: `createTrigger` and `createAction` take a bare Effect schema and
bridge it themselves at registration, so an integration author writes
`schema: Schema.Struct({ ... })` and no wrapper. The addition: Zod is
still a devDependency of `packages/shared`, as the foreign Standard Schema library the
registry tests are written against beside arktype. It is absent from every runtime path
and from every published manifest.

**Behaviour the migration changed on purpose.** Effect Schema is not Zod, and four places
now answer differently from what the Zod version did. Each is chosen; each has a test
pinning it, so a later change to any of them is a decision rather than a drift.

- A node position holding `Infinity` or `NaN` is rejected. `Schema.Finite` is what the
  position now decodes through, where `z.number()` admitted both. An infinite position was
  already corruption, and the editor's save store treats a graph it cannot decode as
  nothing to save, so the rejection is absorbed rather than surfaced.
- Node data whose `type` is missing or is none of the three node kinds fails at `data`
  rather than at `data.type`. Effect selects a union arm by the literal its `type` holds,
  and an input matching no literal selects no arm at all, which leaves nothing to blame a
  field for. The union carries a `message` annotation naming what a node type must be,
  which is also what keeps the rejected node data out of the string: an unmatched union
  prints the whole value it rejected, past the leaf hook `schema-message.ts` installs.
- A trigger config failure mentions the custom-trigger arm beside the real problem. The
  three-arm config union discriminates on `triggerType`, and the third arm takes any
  trigger type a plugin registered, so it has no literal to select on and is tried against
  every config. Its refusal ("Custom triggerType must not be...") rides along with the
  message that names the actual bad field.
- `toStandardSchema` throws when a schema that already carries a Standard Schema
  `validate` is bridged again with parse options. Effect's bridge is first-call-wins, so
  the second set of options would be dropped in silence, and which crossing ran first is
  decided by module initialisation order. `contracts.ts` binds each shared shape's bridged
  form once at module scope rather than bridging at each `.output()`.

## Dependency wiring

`createRovaApp` builds a Layer graph and holds it in a `ManagedRuntime` owned by that app
instance. Four pieces of shared process state are deleted:

- the `globalThis` Proxy over the Drizzle handle in `packages/core/src/backend/lib/db/index.ts`
- the module-level Inngest client in `packages/core/src/backend/lib/inngest/client.ts`
- the module-level step and integration registries
- the `claimProcess` guard in `packages/core/src/app.ts`

The `claimProcess` guard goes away with the state it policed, and that is the whole
story: one Rova per process remains the only supported arrangement. Constructing a
second app in a process is undefined behavior (decided 2026-07-28). The runtime work
is justified by dependency injection and testability, and nothing is added, tested,
or documented to make multiple apps work.

**Amendment, 2026-07-28.** Stage 3b deleted `claimProcess` and `service-result.ts` as
planned, but the database handle and the Inngest client outlive it into stage 7. The run
engine consumes both from outside any runtime, since the step store, the step logger, the
credential fetcher, and the function registry all import them directly, so they cannot
be deleted until stage 7 brings that interior across. `DatabaseLayer` and
`InngestClientLayer` are built from those globals in the meantime, which is what lets the
services above them be injected and tested now.

## Sequencing

Each stage lands green on `main` before the next one starts.

1. Platform exit (ADR-0003).
2. oRPC 2 beta, contracts still described in Zod through Standard Schema.
3. Services get tagged errors, Layers, and the instance-owned runtime.
4. Zod to Effect Schema, contracts included.
5. One vendor HTTP module built on Schema decode.
6. `defineStep` and the Effect-native plugin surface.
7. The workflow-engine interior.

Schema moves at stage 4 so that steps and vendor code arrive at stages 5 and 6 with
Schema-typed inputs already in place, sparing a second pass over the same files.

## Considered Options

- **`effect` 3.22 stable** rejected: adopting v3 guarantees a v3-to-v4 migration of the
  entire backend later, and the guidance we intend to follow targets v4.
- **A Promise-based `@rova/core/plugin`** rejected: it would push every plugin to unwrap
  its own Effects at the boundary, and the built-in plugins are the largest consumer of
  that surface.
- **Zod kept at the wire, Effect Schema inside** rejected: it institutionalizes two schema
  dialects. A prior review found four validation dialects coexisting here, and the repo's
  ethos is one way to do a thing.
- **Staying on oRPC 1.x** rejected: v1 generates its OpenAPI document through `@orpc/zod`
  and has no Effect Schema path, so removing Zod would break the `/rest` spec.
- **Wrapping the existing globals in Layers as a bridge step** rejected as an end state:
  the seam would be cosmetic. Two app instances would still collide over the same globals,
  and every Layer would be a pass-through to module state. Deleting the entire bridge
  would leave behaviour identical, which is the test that tells you it carries no
  structure. It was adopted as an intermediate for stages 3b through 7, which is a
  different claim: a pass-through Layer carries no structure of its own, and it does make
  the services above it injectable and testable now, which is the whole reason the runtime
  exists. See the 2026-07-28 amendment above.

## Consequences

- Pinning a beta means upgrades are deliberate work: a bump can break compilation, so read
  the changelog before moving the pin, and move every `@effect/*` package with it.
- `@rova/core/plugin` changes shape, which is a breaking change to a published surface.
  Third-party integration authors take on Effect as a build-time dependency.
- Zod leaves the dependency tree at stage 4. The AGENTS.md guidance that names Zod at the
  boundary, and the `JsonValue` narrowing rules, need rewriting at that point.
- Test setup gains Effect's own testing tools; see ADR-0003 for the runner they require.
- Drizzle stays, held by a Layer rather than a global; see ADR-0005.
