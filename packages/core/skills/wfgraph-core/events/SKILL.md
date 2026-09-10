---
name: events
description: >
  defineEvent and defineEntity: Event schemas, typed Entity bindings, current-state
  resolvers, Lifecycle Entity Eligibility, correlationPath, umbrella source filters,
  and inngest.send intake. Load when declaring host Events or Entities, choosing
  Lifecycle start/cancel behavior, or deciding between payload and current-state rules.
metadata:
  type: sub-skill
  library: wfgraph
  library_version: "3.1.1"
sources:
  - alandotcom/wfgraph:docs/events.md
---

This skill builds on wfgraph-core. Copy-paste forms live in `docs/events.md`.

# Defining Events and Entities

An Event is a named payload shape the host raises. An Entity is a reusable
host-owned current-state definition that Events may identify. Lifecycle (which
workflow starts, cancels, or checks Entity Eligibility) is declared in the
editor. Pass Event values in `extensions.events`; their referenced Entity
objects are discovered transitively.

## Core Patterns

### Identity and schema

`name` is the identity. `schema` must publish both Standard Schema halves
(validate + JSON Schema) from one object. Zod, arktype, and Effect Schema all
work. A non-object root throws at definition.

### Current Entity State

Use `defineEntity({ type, label, state, resolve })`. `state` must encode to a
JSON object. `resolve({ entityId })` returns current host state or `null` when the
Entity no longer exists. A rejection or schema-invalid result is an operational
failure.

Workflow Graph validates current state only to decide Eligibility. The state
stays out of persistence, templates, node outputs, logs, and audit metadata.
Keep the resolver read-only. Node checkpoints may call it concurrently across
fan-out.

### Typed Event bindings

Add named bindings under `defineEvent({ entities })`. Each binding holds the
Entity object and a synchronous `selectEntityId` typed from the decoded Event
schema. It must return a non-empty string. The original JSON payload still flows
through the workflow.

A guarded Lifecycle selects one Entity type and one compatible binding per Start
and Cancel Event. It can check **Before opening an Execution**, **Before each
workflow node**, or both. Admission runs after the Start Filter and before
Concurrency; a refusal opens no Execution. A node refusal ends the run as
`exited` before that node starts. A host requiring immediate interruption sends
a Cancel Event.

Guarded manual and Draft runs require a Start Event plus valid payload. Guarded
schedules cannot start. Typed Entity identity stays fixed across Wait branches,
replay, and Migration.

### correlationPath

Typed against the payload; must resolve to a string. Unguarded workflows use
that Entity Value for Concurrency and Cancel Events. Optional: a Workflow
Builder can set it in the Lifecycle panel; the builder's path outranks the
author's. Guarded workflows use their selected typed Entity bindings instead.

### Datetime fields

JSON Schema `format: "date-time"` gives before/after operators. Use
`z.iso.datetime()`, arktype `type("string.date.iso").configure({ format: "date-time" })`,
or Effect `Schema.String.annotate({ format: "date-time" })`. Effect's own date
schemas omit the keyword; annotate by hand.

### Umbrella source

When an existing bus sends one name, keep Workflow Graph identity on `name` and
filter with `source: { event, when: { path, equals } }`. Assembly refuses two
Events on one source that both omit `when`.

`when` decides which Event a payload is for every workflow in the app. It belongs
to the Event Author. A Workflow Builder uses a Start Filter or Cancel Filter to
narrow which arrivals change one workflow. A declined Start Filter opens no run.
A declined Cancel Filter leaves active runs unchanged. Wait Subscriptions still
receive either arrival.

### Intake

`inngest.send({ name, data })`. The gate validates declared fields and ignores
unknown keys. Workflow Graph uses the decoded value only for an Entity ID selector and carries
the raw JSON on. Do not transform the workflow payload: a `Date` round-trip
breaks Wait matches captured at park time.

### Integration-owned Events

Pass `events` on `defineIntegration`. Identity stays the Event name. A webhook
is intake. Publish requires a Connection. Host Events have no Connection.

## Common Mistakes

### CRITICAL Persist or expose resolved Entity State

Wrong: return Entity State as node output, put it in audit metadata, or copy it
into a Workflow Graph table.

Correct: let `defineEntity.resolve` return state to the Eligibility adapter only.
Persist typed Entity identity and the non-sensitive decision metadata.

Source: alandotcom/wfgraph:docs/events.md (Current Entity State)

### HIGH Register Entity definitions separately

Wrong: invent an `extensions.entities` array or register on module import.

Correct: reference the reusable Entity object from each Event binding and pass
the Events in `extensions.events`.

Source: alandotcom/wfgraph:docs/events.md (Current Entity State)

### HIGH One Event with a subtype field for two lifecycle roles

Wrong: one `appointment.changed` Event with `type: "created" | "canceled"`.

Correct: `appointment.created` and `appointment.canceled` as two Events.
Subtypes belong on an umbrella `source`.

Source: alandotcom/wfgraph:docs/events.md

### HIGH Transform the payload at intake

Wrong: decode to `Date` objects, then persist that as the Event payload.

Correct: keep ISO strings in the JSON the run carries. Annotate
`format: "date-time"` so the editor offers date operators.

Source: alandotcom/wfgraph:docs/events.md (The intake gate)

### HIGH A `when` filter standing in for one workflow's rule

Wrong: declare `appointment.created.video` with `when: { path: "channel", equals: "video" }`
because one workflow only wants video appointments.

Correct: one `appointment.created` Event, and a Start Filter on that workflow's
Lifecycle Node. Use a Cancel Filter for the same workflow-specific decision on a
Cancel Event. `when` is for a bus that sends one name for several Events, and every
workflow in the app sees the split it makes.

Source: alandotcom/wfgraph:docs/events.md (The umbrella source)

### MEDIUM Schema library without JSON Schema

Wrong: a custom validator that only implements `~standard.validate`.

Correct: Zod / arktype / Effect Schema, so the editor can draw fields.

Source: alandotcom/wfgraph:docs/events.md
