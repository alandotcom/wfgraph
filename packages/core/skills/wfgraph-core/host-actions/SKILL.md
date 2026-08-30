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
wfgraph-core/integrations instead.

# Host actions

`defineAction` is the host vocabulary. An adopter needs no Effect. Fail by
throwing; durable work is `step.run(id, () => promise)`.

## Setup

```ts
import { defineAction } from "@wfgraph/core";
import { z } from "zod";

const cancelAppointment = defineAction({
  id: "appointments/cancel",
  label: "Cancel Appointment",
  description: "Cancels an appointment and records the reason.",
  category: "Appointments",
  input: z.object({
    appointmentId: z.string().describe("Appointment ID"),
    reason: z.string().min(1),
  }),
  output: z.object({
    appointmentId: z.string().describe("Appointment ID"),
    status: z.string(),
    cancelledAt: z.iso.datetime(),
  }),
  handler({ input }) {
    return {
      appointmentId: input.appointmentId,
      status: "cancelled",
      cancelledAt: new Date().toISOString(),
    };
  },
});
```

Pass it in `extensions.actions`. The input schema draws the config form. A
field label is the key in title case unless `description` replaces it.

## Core Patterns

### Promise handler with credentials and step.run

```ts
handler: async ({ input, readCredentials, step }) => {
  const { MY_SERVICE_API_KEY } = await readCredentials();
  if (!MY_SERVICE_API_KEY) {
    throw new Error("MY_SERVICE_API_KEY is not configured.");
  }
  return step.run("create", () =>
    createThing(MY_SERVICE_API_KEY, input.text)
  );
},
```

| Host `defineAction`                     | Integration (`@wfgraph/core/plugin`) |
| --------------------------------------- | ------------------------------------ |
| `async` / plain function                | `Effect.fn` handler                  |
| `await bag.readCredentials()`           | `yield* bag.credentials`             |
| `callExternalAsync`                     | `callExternal`                       |
| `await bag.step.run(id, () => promise)` | `yield* bag.step.run(id, effect)`    |
| Fails by a throw                        | Fails with `StepFailure`             |

### sideEffect

`sideEffect: true` marks a change outside the workflow (send, write, delete).
Default `false` (read). The editor keeps a side-effect action out of a Group.

## Common Mistakes

### HIGH Effect handler on defineAction

Wrong:

```ts
handler: Effect.fn(function* (bag) {
  return yield* doWork(bag.input);
}),
```

Correct: `async` function or plain return, as in Setup. Effect is the
integration path (`defineIntegration`), not the host path.

Source: alandotcom/wfgraph:docs/integrations.md (Effect for integrations, Promise for host actions)

### HIGH Catch around readCredentials

Wrong:

```ts
try {
  return await readCredentials();
} catch {
  return { ok: false };
}
```

Correct: let the refusal fail the node. `readCredentials` rejects with the
store failure; catching it turns that into whatever the handler answers next.

Source: alandotcom/wfgraph:docs/integrations.md

### MEDIUM Missing output field descriptions

Wrong:

```ts
output: z.object({ id: z.string() });
```

Correct:

```ts
output: z.object({ id: z.string().describe("Item ID") });
```

Template autocomplete and the run panel derive labels from descriptions.

Source: alandotcom/wfgraph:docs/embedding.md
