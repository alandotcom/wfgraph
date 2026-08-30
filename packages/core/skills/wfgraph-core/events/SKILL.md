---
name: events
description: >
  defineEvent: name identity, Standard Schema payload, correlationPath, umbrella
  source with when filter, inngest.send intake. Load when declaring host Events,
  webhook umbrellas, Entity Value paths, or Lifecycle start/cancel names.
metadata:
  type: sub-skill
  library: wfgraph
  library_version: "3.1.1"
sources:
  - alandotcom/wfgraph:docs/events.md
---

This skill builds on wfgraph-core. Read it first.

# Defining an Event

An Event is a named payload shape the host raises. Lifecycle (which workflow
starts or cancels) is declared in the editor, not here.

## Setup

```ts
import { defineEvent } from "@wfgraph/core";
import { z } from "zod";

const paymentSettled = defineEvent({
  name: "billing/payment.settled",
  label: "Payment settled",
  description: "The billing service raises this Event when a charge clears.",
  schema: z.object({
    appointmentId: z.string().describe("Appointment ID"),
    amountCents: z.number().describe("Amount settled, in cents"),
    settledAt: z.iso.datetime(),
  }),
  correlationPath: "appointmentId",
});
```

Pass it in `extensions.events`. `name` is the identity. `schema` must publish
both Standard Schema halves (validate + JSON Schema) from one object. Zod,
arktype, and Effect Schema all work. A non-object root throws at definition.

## Core Patterns

### correlationPath

Typed against the payload; must resolve to a string. Runs that share that
Entity Value are about the same entity (concurrency, Cancel Events, Wait).
Optional: a Workflow Builder can set it in the Lifecycle panel; the builder's
path outranks the author's.

### Datetime fields

JSON Schema `format: "date-time"` gives before/after operators:

```ts
z.iso.datetime();
// arktype: type("string.date.iso").configure({ format: "date-time" })
// Effect: Schema.String.annotate({ format: "date-time" })
```

Effect's own date schemas omit the keyword; annotate by hand.

### Umbrella source

When an existing bus sends one name:

```ts
const invoicePaid = defineEvent({
  name: "billing/invoice.paid",
  label: "Invoice paid",
  schema: Schema.Struct({
    type: Schema.String.annotate({ description: "Subtype" }),
    invoiceId: Schema.String.annotate({ description: "Invoice ID" }),
  }),
  correlationPath: "invoiceId",
  source: { event: "billing/webhook", when: { path: "type", equals: "paid" } },
});
```

Identity stays the Workflow Graph name. Assembly refuses two Events on one
source that both omit `when`.

### Intake

```ts
inngest.send({
  name: "app/appointment.created",
  data: { appointment },
});
```

The gate validates declared fields and ignores unknown keys. Workflow Graph
discards the decoded value and carries the raw JSON on. Do not transform at
intake: a `Date` round-trip breaks Wait matches captured at park time.

## Common Mistakes

### HIGH One Event with a subtype field for two lifecycle roles

Wrong:

```ts
defineEvent({
  name: "appointment.changed",
  schema: z.object({ type: z.enum(["created", "canceled"]), id: z.string() }),
});
```

Correct:

```ts
defineEvent({ name: "appointment.created" /* ... */ });
defineEvent({ name: "appointment.canceled" /* ... */ });
```

Lifecycle rules are over Event names. Subtypes belong on an umbrella `source`.

Source: alandotcom/wfgraph:docs/events.md

### HIGH Transform the payload at intake

Wrong: decode to `Date` objects, then persist that as the Event payload.

Correct: keep ISO strings in the JSON the run carries. Annotate `format:
"date-time"` so the editor offers date operators.

Source: alandotcom/wfgraph:docs/events.md (The intake gate)

### MEDIUM Schema library without JSON Schema

Wrong: a custom validator that only implements `~standard.validate`.

Correct: Zod / arktype / Effect Schema, so the editor can draw fields.

Source: alandotcom/wfgraph:docs/events.md
