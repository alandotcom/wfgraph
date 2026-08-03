# Keep Inngest as the durable workflow substrate

_Decided 2026-07-27 by Alan Cohen, following an architecture review._

Effect v4 ships `effect/unstable/workflow`, durable execution in the same library the
backend is adopting (ADR-0002), which raises the obvious question of whether Inngest is
still needed. It is. Inngest stays as the substrate that makes an Execution durable:
memoized step results, function-level retries, sleeps that survive a redeploy, and the
event plumbing behind Wait nodes.

The engine interior becomes Effect anyway. Each `runtime.step` boundary runs its Effect to
a Promise so that Inngest can memoize what comes back, which keeps the two constraints
already documented for this code. Node outputs round-trip through JSON, so they stay
JSON-safe. Retries remain function-level, with each step carrying its own counter.

`WorkflowExecutionRuntime` (`packages/core/src/backend/engine/runtime.ts`)
has four members: `sleep`, `waitForEvent`, `step`, and `runId`. Inngest is invisible behind
them, and `packages/core/src/backend/lib/inngest/workflow-function.ts` is the only place
that supplies the Inngest-backed implementation. A future substrate swap therefore stays
open without being decided now.

## Considered Options

- **`effect/unstable/workflow`** rejected. The module carries an explicit unstable marker
  even inside a beta release line, so its API can move under us while the rest of the
  migration is still in flight. Running it also means running the cluster and persistence
  infrastructure it expects, which Inngest currently supplies as a managed service.
  Adopting it would additionally delete the `inngest` option from `createRovaApp`, an
  embedder-facing contract that ADR-0002 commits to holding stable.

## Consequences

- The engine keeps a Promise boundary in its interior even after the Effect migration, so
  a tagged error crossing `runtime.step` has to survive the JSON round-trip or be
  reconstructed on the far side.
- Revisiting this stays cheap on the code side. The seam is four functions wide, so the
  real work of a swap sits in whatever would replace Inngest's managed durability.

**Amendment, 2026-08-03.** Stage 7 made the engine Effect-native without changing this
substrate. The Promise seam now sits only in the durability adapter: a `runtime.run`
callback runs its Effect with the invocation's current context so Inngest can memoize the
JSON-safe answer. The Inngest function handler runs the enclosing engine Effect on the
app's `ManagedRuntime`.

The comparison with `effect/unstable/workflow` also exposed a behavioral difference that
keeps the rejection above in force. Effect's workflow resumes when any one durable
deferred completes. Inngest resumes a function invocation at the last of its outstanding
pauses. That wake policy is why each waiting branch is handed to a separate durable run in
ADR-0011; replacing the substrate would therefore require replacing that branch hand-off,
not only implementing storage interfaces.
