---
name: host-actions
description: >
  defineAction for host-owned steps: Promise handlers, Standard Schema input and
  output, authored config forms, dependent option callbacks, step.run,
  readCredentials, sideEffect. Load when adding application actions beside
  integrations. Not for defineIntegration (Effect plugin path).
metadata:
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
throwing; durable work is `step.run(id, () => promise)`. Pass the value in
`extensions.actions`. The input schema draws the config form. The editor derives
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

| Host `defineAction`                     | Integration (`@wfgraph/core/plugin`) |
| --------------------------------------- | ------------------------------------ |
| `async` / plain function                | `Effect.fn` handler                  |
| `await bag.readCredentials()`           | `yield* bag.credentials`             |
| `callExternalAsync`                     | `callExternal`                       |
| `await bag.step.run(id, () => promise)` | `yield* bag.step.run(id, effect)`    |
| Fails by a throw                        | Fails with `StepFailure`             |

Credentials and `step.run` usage: `docs/embedding.md` (the host action
example) and `docs/integrations.md` ("Effect for integrations, Promise for
host actions").

### sideEffect

`sideEffect: true` marks a change outside the workflow (send, write, delete).
Default `false` (read). The run dialog counts these steps and names their
integrations before a Live published run. Grouping ignores the field.

## Common Mistakes

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
