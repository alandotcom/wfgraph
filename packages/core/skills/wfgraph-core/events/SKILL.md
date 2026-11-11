---
name: events
description: >
  Use when a host application tells Workflow Graph that something happened:
  declaring an Event with defineEvent, declaring host-owned current state with
  defineEntity and binding it to Events, sending Events with a typed
  app.events.send, POST /api/events, an insert into the event inbox inside the
  host's own transaction with events.inboxInsert, or inngest.send through
  @wfgraph/core/inngest, splitting one bus name into several Events with an
  umbrella source, or choosing between a payload rule and a current-state
  Eligibility rule. Also use for requests such as "start a workflow when an
  appointment is created", "stop reminders once the patient is inactive" or "our
  message bus sends every event under one name". For mounting the app or the
  worker loop use wfgraph-core; for Events that an integration's webhook
  produces use wfgraph-core/integrations.
metadata:
  purpose: >
    defineEvent and defineEntity: Event schemas, typed Entity bindings, current-state
    resolvers, Lifecycle Entity Eligibility, correlationPath, umbrella source filters,
    and intake through app.events.send, POST /api/events, or inngest.send with the
    forwarders from @wfgraph/core/inngest. Load when
    declaring host Events or Entities, sending Events, choosing
    Lifecycle start/cancel behavior, or deciding between payload and current-state rules.
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

`name` is the stable Event identity and transport name by default. `label` is
the human-readable Event name, and `description` is its explanatory text in the
editor. `schema` must publish both Standard Schema halves (validate + JSON
Schema) from one object. Zod, arktype, and Effect Schema all work. A non-object
root throws at definition.

For each payload property, the editor derives a readable label from the final
property key and preserves common initialisms (`appointmentId` becomes
"Appointment ID"). JSON Schema `description` supplies separate help text. In
Zod 4, `.describe(...)` sets that help text. Use JSON Schema `title` only when
the intended label cannot be derived from the key. For a closed string set,
`title` on each singleton `const` or `enum` branch under `anyOf` or `oneOf`
labels that choice while conditions and Test Runs keep its original value. Use
an annotated Zod literal union or an Effect `Schema.Enum` with human-readable
object keys; unlabelled choices display their values.

### Current Entity State

Use `defineEntity({ type, label, state, resolve })`. `state` must encode to a
JSON object. `resolve({ entityId })` returns current host state or `null` when the
Entity no longer exists. The resolver has 10 seconds to settle by default;
`createWfGraphApp({ entityResolverTimeoutMs })` or
`wfWorker({ entityResolverTimeoutMs })` sets another positive whole-number
deadline. A timeout, rejection, or schema-invalid result is an
operational failure.

Workflow Graph validates current state for Eligibility and node-local Entity
references. Tracking makes Entity fields available to text templates and
Condition nodes without requiring Eligibility. Each consuming node resolves
fresh state immediately before it runs; a before-node check, templates, and the
Condition share one snapshot. The durable boundary retains only referenced
values for replay. Full state stays out of Workflow Graph persistence and node
outputs, and all Entity State stays out of logs and audit metadata. Keep the
resolver read-only. Nodes may call it concurrently across fan-out.

### Typed Event bindings

Add named bindings under `defineEvent({ entities })`. Each binding holds the
Entity object and a synchronous `selectEntityId` typed from the decoded Event
schema. It must return a non-empty string. The original JSON payload still flows
through the workflow.

A tracked Lifecycle selects one Entity type and one compatible binding per Start
and Cancel Event. Tracking can stand alone for typed Concurrency and cancellation
identity. An optional Eligibility rule can check **Before opening an Execution**,
**Before each workflow node**, or both. Admission runs after the Start Filter and before
Concurrency; a refusal opens no Execution. A node refusal ends the run as
`exited` before that node starts. A host requiring immediate interruption sends
a Cancel Event.

Tracked manual and Draft runs require a Start Event plus valid payload. Tracked
schedules cannot start. Typed Entity identity stays fixed across Wait branches,
replay, and Migration.

### correlationPath

Typed against the payload; must resolve to a string. Untracked workflows use
that Entity Value for Concurrency and Cancel Events. Optional: a Workflow
Builder can set it on the Lifecycle Node; the builder's path outranks the
author's. Tracked workflows use their selected typed Entity bindings instead.

### Datetime fields

JSON Schema `format: "date-time"` gives before/after operators. Use
`z.iso.datetime()`, arktype `type("string.date.iso").configure({ format: "date-time" })`,
or Effect `Schema.String.annotate({ format: "date-time" })`. Effect's own date
schemas omit the keyword; annotate by hand.

### Umbrella source

When an existing bus sends one name, keep Workflow Graph identity on `name` and
filter with `source: { event, when: { path, equals } }`. The worker loop
delivers an arrival on the umbrella name as the Event whose `when` its payload
satisfies. Assembly refuses two Events on one source that both omit `when`.

`when` decides which Event a payload is for every workflow in the app. It belongs
to the Event Author. A Workflow Builder uses a Start Filter or Cancel Filter to
narrow which arrivals change one workflow. A declined Start Filter opens no run.
A declined Cancel Filter leaves active runs unchanged. Wait Subscriptions still
receive either arrival.

### Intake

Four ways in, and every one lands in the event inbox, which the worker loop
delivers:

- `app.events.send(appointmentCreated, data, { id })` from the host's code,
  with the value `defineEvent` returned, which types `data` from the Event's
  schema. A sender holding only a name passes `{ name, data, id? }`, checked
  at runtime alone. `createWfGraphRunner`'s answer carries the same `events`.
- `POST {basePath}/api/events` with `Authorization: Bearer <events.key>` from
  another process, mounted only when `events.key` is set.
- An insert into `workflow_event_inbox` inside the host's own transaction,
  when the host shares the database. `app.events.inboxInsert(event, data, { id })`
  checks the payload as a send does and answers `{ sql, params, namedParams }`
  for the host to run on its own connection; it writes nothing itself. On
  PostgreSQL the statement qualifies the table with the `persistence` schema.
  A hand-written insert is checked only when the loop delivers it.
- `inngest.send({ name, data, id? })` through the forwarders below.

`id` is the idempotency key, and it holds only while the first send's inbox
row exists: the loop deletes a settled row after `events.retentionMs` (seven
days by default), and the same `id` after that is a new arrival that starts
runs again. A resend of an `id` whose delivery failed delivers it again, and
each workflow that already received it answers from the decision it recorded,
so a start the first delivery refused stays refused. A send that names no host
Event (or umbrella name), names an integration-owned Event, or carries data the
Event's schema refuses, is refused with `WfGraphEventRefused` before anything
is stored.

A delivery retries each workflow the Event concerns on its own, so one
workflow whose Entity resolver keeps failing does not hold the Event back from
the rest. Once that workflow's retries are spent, it alone gets a
`delivery_failed` audit row, and the inbox row settles `failed` with an error
naming each workflow that failed. A paused workflow opens no new run, and a
Cancel Event and a Wait's Event still reach its runs in flight.

A host already on Inngest keeps `inngest.send` by registering
`createWfGraphInngestFunctions({ client, app })` from
`@wfgraph/core/inngest` on its own Inngest `serve` or `connect`. Workflow Graph
mounts no Inngest route and builds no Inngest client. Each forwarder covers one
name a host Event arrives under (its umbrella `source` name, if it has one) and
calls `app.events.send` keyed by the Inngest event `id`, so it gates the payload
like any send: a refused one fails the Inngest run with `NonRetriableError` and
stores nothing. An integration-owned Event gets no forwarder. `inngest` is an
optional peer dependency that only this entry imports. The gate
validates declared fields and ignores unknown keys. Workflow Graph uses the decoded value only for an Entity ID selector and carries
the raw JSON on. Do not transform the workflow payload: a `Date` round-trip
breaks Wait matches captured at park time.

### Integration-owned Events

Pass `events` on `defineIntegration`. Identity stays the Event name. A webhook
is intake, and it records each arrival with the Connection it came through.
Publish requires a Connection. A host send carries no Connection.

## Common Mistakes

### CRITICAL Persist or expose full resolved Entity State

Wrong: return full Entity State as a node output, put it in audit metadata, or
copy it into a Workflow Graph table.

Correct: let the virtual Entity template source project only authored field
references. Its durable node step retains those projected values for replay.
Persist typed Entity identity and non-sensitive decision metadata separately.

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

### MEDIUM A hand-written inbox insert on the default search_path

Wrong: `insert into workflow_event_inbox (name, data, idempotency_key) values ($1, $2, $3)`
on a PostgreSQL connection whose `search_path` starts at `public`.

Correct: run the statement `app.events.inboxInsert(...)` answers, which names
the `persistence` schema and checks the payload first.

The table lives in `_workflows` by default, so the insert fails to find it, and
a payload the schema refuses is only marked failed later, when the loop
delivers it.

Source: alandotcom/wfgraph:docs/events.md (Sending an Event)

### MEDIUM Schema library without JSON Schema

Wrong: a custom validator that only implements `~standard.validate`.

Correct: Zod / arktype / Effect Schema, so the editor can draw fields.

Source: alandotcom/wfgraph:docs/events.md
