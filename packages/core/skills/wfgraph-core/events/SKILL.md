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

This skill builds on wfgraph-core. Copy-paste forms live in `docs/events.md`.

# Defining an Event

An Event is a named payload shape the host raises. Lifecycle (which workflow
starts or cancels) is declared in the editor, not here. Pass the value in
`extensions.events`.

## Core Patterns

### Identity and schema

`name` is the identity. `schema` must publish both Standard Schema halves
(validate + JSON Schema) from one object. Zod, arktype, and Effect Schema all
work. A non-object root throws at definition.

### correlationPath

Typed against the payload; must resolve to a string. Runs that share that
Entity Value are about the same entity (concurrency, Cancel Events, Wait).
Optional: a Workflow Builder can set it in the Lifecycle panel; the builder's
path outranks the author's.

### Datetime fields

JSON Schema `format: "date-time"` gives before/after operators. Use
`z.iso.datetime()`, arktype `type("string.date.iso").configure({ format: "date-time" })`,
or Effect `Schema.String.annotate({ format: "date-time" })`. Effect's own date
schemas omit the keyword; annotate by hand.

### Umbrella source

When an existing bus sends one name, keep Workflow Graph identity on `name` and
filter with `source: { event, when: { path, equals } }`. Assembly refuses two
Events on one source that both omit `when`.

### Intake

`inngest.send({ name, data })`. The gate validates declared fields and ignores
unknown keys. Workflow Graph discards the decoded value and carries the raw JSON
on. Do not transform at intake: a `Date` round-trip breaks Wait matches captured
at park time.

## Common Mistakes

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

### MEDIUM Schema library without JSON Schema

Wrong: a custom validator that only implements `~standard.validate`.

Correct: Zod / arktype / Effect Schema, so the editor can draw fields.

Source: alandotcom/wfgraph:docs/events.md
