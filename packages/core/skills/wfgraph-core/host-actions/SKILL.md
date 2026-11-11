---
name: host-actions
description: >
  Use when a host application adds its own step to the Workflow Graph editor
  with defineAction: a Promise handler that calls application code, Standard
  Schema input and output that draw the config form and template autocomplete,
  configFields presentation, options callbacks for application-owned pickers,
  step.run and idempotency keys so a retry repeats no write, runMode checks so
  a Draft or Test-mode run touches nothing real, readCredentials, sideEffect,
  or testing the action with runHostAction. Also use for requests such as "let
  workflows call our cancel-appointment API", "a retry must not refund twice"
  or "show a dropdown of our message templates in a workflow step". For
  packaging a vendor API as an integration with Effect handlers, credential
  forms or OAuth use wfgraph-core/integrations; for turning on the built-in
  vendors use wfgraph-plugins.
metadata:
  purpose: >
    defineAction for host-owned steps: Promise handlers, Standard Schema input and
    output, authored config forms, dependent option callbacks, step.run,
    readCredentials, sideEffect. Load when adding application actions beside
    integrations. Not for defineIntegration (Effect plugin path).
  type: sub-skill
  library: wfgraph
  library_version: "3.1.1"
sources:
  - alandotcom/wfgraph:docs/embedding.md
  - alandotcom/wfgraph:docs/integrations.md
---

This skill builds on wfgraph-core. For vendor integrations, load
wfgraph-core/integrations instead. Copy-paste the host action from
`docs/embedding.md`; the Effect vs Promise table is in `docs/integrations.md`.

# Host actions

`defineAction` is the host vocabulary. An adopter needs no Effect. Fail by
throwing. Pass the value in `extensions.actions`. The input schema draws the
config form. The editor derives
a readable label from each property key and preserves common initialisms
(`appointmentId` becomes "Appointment ID"). JSON Schema `description` supplies
separate help text. Use `title` only when the intended label cannot be derived
from the key. A closed string set can label each choice with `title` on its
singleton `const` or `enum` branch under JSON Schema `anyOf` or `oneOf`. Use an
annotated Zod literal union; the editor displays each title and stores its raw
literal value. Use `configFields` for presentation the schema cannot express,
including grouping, ordering, placeholders, and conditional visibility. For an input
shared by several variants, keep one schema key and use `showWhen.in`; use
`showWhen.equals` for one variant. Both forms constrain `field` to an input-schema key.
Read the matching contract in `docs/integrations.md` ("The config form").

Use `options` keyed by input-schema fields for application-owned pickers. Each
callback receives current draft selections as optional raw strings, without
Connection credentials. Return choices directly, or an `unavailable` result for
an expected refusal. Handle missing selections when choices depend on another
field. These callbacks guide the editor; validate execution requirements in the
action itself. Copy the dependent-picker example and read the refresh and failure
contract in `docs/embedding.md` ("Dynamic host action fields").

## Core Patterns

### Promise handler, not Effect

| Host `defineAction`                       | Integration (`@wfgraph/core/plugin`) |
| ----------------------------------------- | ------------------------------------ |
| `async` / plain function                  | `Effect.fn` handler                  |
| `await bag.readCredentials()`             | `yield* bag.credentials`             |
| `callExternalAsync` from `@wfgraph/core`  | `callExternal`                       |
| `await bag.step.run(name, () => promise)` | `yield* bag.step.run(name, effect)`  |
| Runs once per node of a run               | Runs on every pass                   |
| Fails by a throw                          | Fails with `StepFailure`             |

Credentials and `step.run` usage: `docs/embedding.md` ("A handler runs once
per node of a run") and `docs/integrations.md` ("Effect for integrations,
Promise for host actions").

### A handler runs once per node of a run

A run executes in passes and replays the graph from its trigger on each one.
The whole handler runs inside one durable step of its node, so once it has
answered, or has thrown outside any `step.run`, every later pass of that run
reads its stored answer and the handler is not called again for that node. A
throw outside `step.run` fails the node once.

`step.run(name, work)` marks a part a retry resumes past. A throw inside
`work` is retried by the executor, up to its step retry limit, and the next
pass calls the handler again with every finished `step.run` answered from the
memo. Put each call to an outside system in a `step.run` of its own, so a
failed second write does not repeat the first. A name is 1 to 64 characters
and is scoped to its node, so two nodes running the action never share one.
What a step answers must be JSON, and at most `runner.maxStepValueBytes` of
it (1 MiB by default); a larger answer fails the node with no retry.

### Idempotency keys

A handler and a step are at-least-once: a process that dies during a call,
before its answer is stored, leaves the call to run again. The bag's
`idempotencyKey` is the same on every pass and retry of one node and differs
between two nodes. `step.run` hands its `work` a key of its own as
`{ idempotencyKey }`, and `step.idempotencyKey(name)` answers the same key for
any step name. Pass the key to a system that deduplicates by it, one key per
call. `executionId` on the bag is always a string.

### Test runs call the handler

A Draft run, and a run of a published version whose workflow is in Test mode,
call every handler they reach with `runMode: "test"`. Workflow Graph neither
skips nor stubs a host action in a test run, so a handler that charges,
cancels, deletes or sends checks `runMode` and answers without doing so, or
does it against a sandbox.

### sideEffect

`sideEffect: true` marks a change outside the workflow (send, write, delete).
Default `false` (read). The catalog carries it to the editor, and the run
dialog of a Live published run counts the integration steps that declare it;
a host action is not counted there. It changes nothing about whether or how
the handler runs, in a test run or any other. Grouping ignores the field.

### Testing the action

`runHostAction(action, { input, runMode?, credentials?, memo?, node? })` from
`@wfgraph/core/testing` runs the action the way one pass of a run runs its
node, and resolves with `result` (read it with `actionData` or
`actionError`), `handlerRan`, every `step.run` in `steps`, and the `memo` the
pass leaves. Hand an earlier run's `memo` to a second call to check that the
handler is not called again, or pass `memo: { steps: { name: value } }` to
check the pass after a later step failed. A `step.run` whose work throws
rejects the promise, since the executor retries it; a throw outside `step.run`
resolves with the node's failure. Copy the cases from `docs/embedding.md`
("Testing a host").

## Common Mistakes

### CRITICAL A side effect with no runMode check

Wrong: a refund, cancellation or message sent unconditionally, on the
assumption that a Draft run skips a step marked `sideEffect: true`.

Correct: `if (runMode === "test") return { status: "skipped" }` before the
call, or send it to a sandbox in test mode.

A Workflow Builder's Draft run calls the handler with real input, so a refund
workflow tested in the editor issues a real refund.

Source: alandotcom/wfgraph:docs/embedding.md (Test runs call your handler)

### HIGH Two external calls in one step

Wrong: `await step.run("refund-and-email", async () => { await refund(); await email(); })`.

Correct: `step.run("refund", ...)` then `step.run("email", ...)`, each passing
the `idempotencyKey` its `work` is handed.

When the email throws, the executor retries the whole step, and the refund
runs again.

Source: alandotcom/wfgraph:docs/embedding.md (A handler runs once per node of a run)

### HIGH A key the vendor never sees

Wrong: wrap the vendor call in `step.run` and send it no idempotency key.

Correct: pass `idempotencyKey` from the bag, or the key `step.run` hands its
`work`, to a vendor that deduplicates by key.

A process that dies after the vendor applied the call and before its answer
was stored runs the call again on the next pass.

Source: alandotcom/wfgraph:docs/embedding.md (A handler runs once per node of a run)

### HIGH Effect handler on defineAction

Wrong: `handler: Effect.fn(function* (bag) { return yield* doWork(bag.input) })`.

Correct: `async` function or plain return. Effect is the integration path
(`defineIntegration`), not the host path.

Source: alandotcom/wfgraph:docs/integrations.md (Effect for integrations, Promise for host actions)

### HIGH Catch around readCredentials

Wrong: `try { return await readCredentials() } catch { return { ok: false } }`.

Correct: let the refusal fail the node. Catching it turns a store failure into
whatever the handler answers next.

Source: alandotcom/wfgraph:docs/integrations.md

### MEDIUM Redundant or missing field title

Wrong: annotate `appointmentId` with `title: "Appointment ID"`; the editor already
derives that label. Also wrong: leave `id` unannotated when the intended label is
"Item ID".

Correct: use `appointmentId: z.string()` for the derived label and
`id: z.string().meta({ title: "Item ID" })` for the override. Add `description`
only when the field needs explanatory help text. Template autocomplete and the
Runs view retain the raw path.

Source: alandotcom/wfgraph:docs/embedding.md
