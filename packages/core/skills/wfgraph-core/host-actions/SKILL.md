---
name: host-actions
description: >
  defineAction for host-owned steps: Promise handlers, Standard Schema input and
  output, step.run, readCredentials, sideEffect. Load when adding application
  actions beside integrations. Not for defineIntegration (Effect plugin path).
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
`extensions.actions`. The input schema draws the config form. A field label is
the key in title case unless `description` replaces it.

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
Default `false` (read). The editor keeps a side-effect action out of a Group.

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

### MEDIUM Missing output field descriptions

Wrong: `output: z.object({ id: z.string() })`.

Correct: `id: z.string().describe("Item ID")`. Template autocomplete and the
run panel derive labels from descriptions.

Source: alandotcom/wfgraph:docs/embedding.md
