# 22. Events arrive through an inbox in the application database, delivered by the executor

Date: 2026-11-05

## Status

Accepted. This decision completes the intake half of the design ADR-0021 began, and it
amends ADR-0015.

## Context

ADR-0021 moved workflow runs onto an executor in the application database and left Event
delivery on Inngest. Each catalog Event registered an Inngest listener function, and that
function ran the fan-out that starts, cancels and wakes runs: a lifecycle step per
subscribing workflow, then each page of parked Wait candidates. Inngest stored the arrival,
memoized the fan-out's steps, and retried a delivery that failed.

That left four costs. Every adopter still ran Inngest to receive an Event, including an
adopter that had no other use for an event bus. The arrival had no record in the adopter's
database, so a delivery that failed for good was visible only in Inngest's dashboard, and
`workflow_executions.delivery_id` named an Inngest event id nothing in the database could
look up. A host could not raise an Event inside the transaction that produced the business
fact, so a crash between the commit and the send lost the Event. And `defineEvent` exposed
Inngest's per-Event flow control (`rateLimit`, `throttle`, `debounce`, `priority`,
`timeouts`, `retries`), which tied the Event definition to one vendor, although no Event in
this repository or in the one adopter's branch declared any of them.

Section 7 of `docs/internal/plans/separate-event-intake-from-durable-execution.md` worked
through the intake design, and its section 12 records the owner's decisions.

## Decision

Every Event arrives as a row in `workflow_event_inbox`, in the database the `persistence`
option names, and the executor delivers it.

**The inbox row is the arrival.** It holds the Event's `name`, its `data` as a JSON
object, the `connection_id` of the Connection an integration Event arrived through, the
sender's `idempotency_key`, `received_at`, and a `status` of `pending`, `delivered` or
`failed`, with `error` and `settled_at` on a settled row. A unique index over the name, the
Connection (an absent one counted as the empty string) and the key refuses a second row
with the same three, so a resent arrival is answered with the first row's id and starts
nothing. A row with no key is never a duplicate. The inbox id is the `deliveryId` every run
the arrival opens carries, and `workflow_executions.delivery_id` stays a plain text column
with no foreign key, so a run outlives its inbox row.

**A delivery is a second pass body on the executor.** A send writes the inbox row and a
`delivery` schedule row in one transaction. The worker loop claims a delivery row under the
same lease, owner token and step memo a run uses, and its body resolves which catalog Event
the row is, gates the payload through that Event's schema, and runs the fan-out with
memoized steps named `subscribers-*`, `lifecycle-*`, `wait-candidates-*` and `waits-*`. A
retried delivery answers each step that committed from its memo row, and a lifecycle step
whose memo row a crash lost finds the run it already started by its delivery id. Settling
the delivery marks the inbox row `delivered`, or `failed` with its error, and deletes the
schedule row and its memo in the same transaction, fenced on the owner token. A row named
by an umbrella source is resolved by each Event's `source.when` filter, evaluated in the
delivery body.

**A failed delivery is recorded and logged, and the editor shows nothing new.** A payload
the Event refuses, a name no Event declares, and a step past its retries each settle the
row `failed` with a reason that quotes nothing of the data, and the pass writes one log
record. The poll never schedules a `failed` row again.

**Five sources write the inbox.**

- `app.events.send({ name, data, id? })` on the value `createWfGraphApp` and
  `createWfGraphRunner` return, validated against the catalog before anything is stored.
- `POST {basePath}/api/events`, authenticated by `Authorization: Bearer <key>` with the key
  from the `events.key` option. The route is mounted only when the key is set, and it
  answers 202 `{ id, duplicate }`, 400 for a refused payload, and 401 for a missing or
  wrong key.
- Webhook intake, which records the Connection in its column.
- A host's own `insert ... on conflict do nothing` inside its own transaction, the SQL
  contract documented at `workflowEventInbox` in the schema. The loop's poll gives such a
  row its schedule row.
- An Inngest forwarder per name a host Event arrives under, which records each
  `inngest.send` in the inbox keyed by the Inngest event id, so a host on Inngest needs no
  change.

**The worker loop claims deliveries in a lane of their own.** A claim takes rows of one
kind. The loop keeps `runner.concurrency` slots for runs and
`runner.deliveryConcurrency` slots, 1 by default on every backend, for deliveries. A Cancel
is a delivery, so it is applied while every run slot is held by a long step.

**Settled rows are kept for `events.retentionMs`.** The option on `createWfGraphApp` and
`createWfGraphRunner` defaults to seven days, so a host retrying a send over a weekend
still deduplicates. Once an hour the loop deletes up to 1,000 settled rows that arrived
before the window, and sweeps again at its next poll when it reached that limit. A
`pending` row is never deleted. A window that is not a positive integer fails at startup.

**`defineEvent` lost its `inngest` option.** Per-Event flow control was dropped. A delivery
retries under the executor's own per-step retry limit, the same one a run uses.

## Considered Options

- **An external bus, such as Kafka, SQS or a hosted queue**, rejected. It would be a second
  system of record beside the adopter's database, with its own retention, credentials and
  failure modes, and a host could not write to it inside its own database transaction, which
  the SQL contract allows. It also has no SQLite form.
- **Keeping Inngest as the delivery engine**, rejected. The fan-out would keep its memo and
  retries in Inngest while the runs it opens live in the executor, so a delivery and its
  runs would answer to two retry policies and two dashboards. Every adopter would keep
  running Inngest, and a delivery's failure would stay out of the database. Inngest stays
  as a forwarding source only.
- **A table per source**, rejected. A webhook table, an HTTP table and an Inngest table
  would each need their own delivery body, uniqueness and sweep, and a Wait or a Cancel would
  have to know which table an Event came from. One table with a nullable Connection column
  and one key index serves every source.

## Consequences

The inbox grows by one row per arrival, and the retention sweep bounds it at the arrivals of
one window plus the rows still pending. The window is also the deduplication window: a key
is refused only while its first row exists, and a resend after the sweep starts runs again.
Inngest's own window is 24 hours.

`workflow_event_inbox` and its insert are a contract a host's SQL depends on. A change to
the table's required columns, its defaults or its uniqueness is a breaking change for a
host that inserts directly, in the way a change to `app.events.send` is.

Inngest remains a forwarding source until phase 4 of the design document, so the `inngest`
option stays required and the forwarders stay registered. An integration-owned Event gets
no forwarder, because an Inngest send carries no Connection.

The delivery lane adds one claim per loop iteration on every backend, which doubled the
claims a SQLite loop made while it drained 200 runs. On SQLite each claim is a
`BEGIN IMMEDIATE` transaction on the main thread. At SQLite's default run concurrency of 1,
the event-loop delay's 99th percentile stayed between 12 and 14 ms; at a run concurrency of
10 it rose from about 25 ms to about 29 ms. On PostgreSQL the two lanes share the pool, so a
loop at its defaults can hold 11 connections.

Every caller of `applyLifecycleRules` and `deliverWaitCandidates` passes a delivery id,
which the type now requires, so a start answered from its committed decision and a wake
recorded with its arrival no longer have an arm for a delivery with no id.
