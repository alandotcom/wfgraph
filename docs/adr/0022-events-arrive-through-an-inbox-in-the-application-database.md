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

## Amendment: Resends, Cancel decisions and host sends

Date: 2026-11-05

A resend of a `failed` row's key answered as a duplicate, and the poll never scheduled a
`failed` row again, so a webhook whose delivery failed during an outage was lost when the
vendor resent it. A resend of a `failed` row's key now reopens that row as `pending`, with
its error and settled time cleared and its id and data kept, and gives it a new `delivery`
schedule row in the same transaction. A `pending` or `delivered` row still answers a resend
as a duplicate.

A Cancel delivery that crashed after its claim committed and before its step's memo row
re-ran the claim, which could flag a run that opened after the first attempt. The claim now
records its decision as a `workflow_cancel_decisions` row for the workflow and the inbox id,
in its own transaction and whether or not it flagged a run, and writes each flagged run's
`run_cancel_requested` entry there too. A retry that finds the decision flags nothing new
and answers the runs the first attempt flagged. The decision rows go with their inbox row
when the retention sweep deletes it.

`app.events.send` and the events route accept only an Event the host declared, by its own
name or by the umbrella name it arrives under, which is what the Inngest forwarders accept.
An integration-owned Event arrives only through its integration's webhook, with its
Connection. One resolver on the extension set decides which Event an arrival is for a send
and for the delivery body, and assembly refuses an Event named after another Event's
umbrella name.

## Amendment: One claim answers every lane, and the sweep runs beside the claims

Date: 2026-11-05

The loop made one claim per lane on every iteration. A claim now takes a limit per lane and
reads the due rows of every lane in one statement, so an iteration costs one claim whatever
its lanes. On SQLite at a run concurrency of 10, the claims a loop made while it drained 200
runs fell from about 765 to about 370. The event-loop delay's 99th percentile stayed
between 26 and 28 ms and its maximum between 27 and 28 ms, so the passes, which did not
change, account for that stall.

The retention sweep ran inline before the claims, so an hourly delete held back both lanes.
It now runs beside them, and a stopped loop drains it with its passes. `tick` sweeps too,
on every invocation, with a retention window of its own, so a host that runs only the tick
driver keeps no settled row forever. Every process that runs a loop or a tick sweeps with
its own window.

## Amendment: The Inngest source leaves the core

Date: 2026-11-06

The forwarders moved to a published entry, `@wfgraph/core/inngest`, and `inngest` became an
optional peer dependency that only that entry imports. `createWfGraphApp` and the Worker
entry lost their `inngest` option, and the app mounts no `/api/inngest` route and builds no
Inngest client. A host on Inngest builds the forwarders with
`createWfGraphInngestFunctions({ client, extensions, app })` on its own client and registers
them with its own `serve` or `connect`, so its signing keys and Connect settings are its own.

Each forwarder sends through the app's `events.send`, the public send, keyed by the Inngest
event id. The forwarder therefore checks the payload at intake like any send: a refused
payload fails the Inngest run with `NonRetriableError` and stores no inbox row, where the
forwarder used to store it for the delivery to mark failed. The check that two forwarded
names slug to one Inngest function id moved from extension assembly to the entry. The
example app, `pnpm run dev` and the reliability suite run without Inngest.

## Amendment: Each workflow is a delivery's retry unit

Date: 2026-11-11

The fan-out ran every workflow's steps in one fiber, and a step that threw stopped the pass.
A workflow whose step kept failing, such as one whose Entity resolver timed out, held back
every workflow after it on each retry, and once its retries were spent the whole delivery
settled `failed`. A Cancel Event then cancelled nothing in the workflows that came later, and
their Waits timed out.

A step of one workflow's delivery now holds its failure as its memoized value, so the pass
goes on to every other workflow. The next pass tries that step again under an id of its own,
`<step id>-retry-<n>`, while every other workflow is answered from the memo. A pass that
still has a step to try again ends with `DeliveryStepsPending`, which the release counts
against the delivery row and backs off, so the row's own retry limit bounds the retries of
every workflow at once. A step that fails when the row has no retry left is recorded for its
workflow alone: a lifecycle step writes a `run_refused` row for a Start Event or a
`cancel_not_delivered` row for a Cancel Event, with `reason: "delivery_failed"`, and the
Event still reaches that workflow's Waits.

A delivery with a workflow that failed this way settles its row `failed`, with an error that
counts the workflows the Event reached and names each one that failed, because the row's
constraint keeps `delivered` free of an error and a resend of a `failed` row's key reopens
it. A resend delivers the Event again, and every workflow that already received it answers
from its committed decision.

## Amendment: A failed delivery keeps its memo for a resend

Date: 2026-11-11

Settling a delivery deleted its schedule row and its step memo whether it was delivered or
failed. A resend of a failed row's key then reopened the row with a new schedule row and an
empty memo, so the second fan-out ran every workflow's steps again. A start answered from its
committed decision and a Cancel from its decision row, but a Wait page did not: the reopened
delivery scanned each workflow's parked runs again, and a run the first delivery had woken and
that had since parked on a second Wait on the same Event was woken a second time by one
arrival.

A delivery that fails for good now keeps its schedule row in a fourth state, `settled`, with
its step memo. No claim takes a settled row and the poll never schedules a `failed` inbox row.
A resend that reopens the row queues that same schedule row again with no failure counted, so
the reopened delivery answers every step the first one memoized, including each Wait page it
offered, and tries again only the steps of the workflows that failed. A failed workflow's
retries on the reopened delivery are bounded by the row's own failure count alone, which the
reopen resets, so each resend gives it a full set of retries. A delivered row still deletes its
schedule row and memo, since a resend of its key is a duplicate. A settled row and its memo go
with their inbox row when the retention sweep deletes it.

## Amendment: A Cancel follows arrival order

Date: 2026-11-11

A Cancel claim took every in-flight run of its Entity when its delivery ran. A start whose
delivery was held back, by a retry or by a second process delivering beside the first,
opened its run after a Cancel received later had already been applied, so the run went
uncanceled. The reverse ordering canceled a run whose start was received after the Cancel.
On PostgreSQL the same miss happened with no delay at all when two processes delivered the
two Events at once, since each transaction read before the other committed.

The rule is now stated by arrival: a Cancel Event reaches a run whose start Event was
received no later than it, and never one whose start Event was received after it, whichever
is delivered first. The `workflow_cancel_decisions` row records the Cancel's Event name, the
Entity it named in each identity form, and its inbox row's `received_at`. A start that opens
a run looks for a decision of its workflow and Entity, in the run's own form, received no
earlier than its own inbox row, and claims the run for the earliest such Cancel in the
transaction that opens it, with the Cancel's payload and timeline entry. A Cancel claim
passes over a run whose start's inbox row was received after its own. A run no Event started,
or whose start's inbox row the retention sweep deleted, has no arrival to compare and is
claimed as before. A tie counts as received before the Cancel, in both orders.

On PostgreSQL each side takes a transaction-scoped advisory lock on the Entity before it
reads, exclusive for a Cancel and shared for a start, so concurrent starts of one Entity do
not wait on each other. A start that decides in a SERIALIZABLE transaction tries the lock as
its first statement and retries with a fresh snapshot when a Cancel held it. SQLite's single
writer serializes the two already.

The alternative rule, that a Cancel reaches every run of its Entity in flight when it is
delivered, is what the code did; it makes the outcome depend on delivery order, which a
retry or a second process decides. First-wins Concurrency still compares runs as they stand
when the start is delivered, so a start refused in arrival order because an earlier run was
in flight can open, already claimed, when the Cancel of that earlier run was delivered first.

## Amendment: A Wait catches up on an arrival it missed

Date: 2026-11-11

A delivery offers an Event to the Waits parked when it scans. A run that was still on its
way to an event-mode Wait when the Event was delivered parked afterwards and waited for the
next arrival, usually until its timeout, although the Event it waited for had been delivered.

An event-mode Wait now asks for that arrival when it first parks. It reads the `delivered`
inbox rows recorded under its Events, or the source names they arrive under, received since
its run started: the run's start Event's `received_at`, or its start time when no Event
started it. The run's own start delivery, the Cancel delivery that claimed it, and every
arrival a Wait of the run was already woken by are left out, so an arrival never resumes a
run it started, a run it canceled, or a second Wait of one run. Each row is resolved to its
Event as its delivery resolved it and offered to the row's subscriptions and match in
arrival order, and the first that matches claims the park with the claim a delivery makes.

The window is the run's, not the branch's, because a branch's Arriving Event carries no
delivery id the engine could bound it by; the exclusions are what keep the run's own
arrivals out. A pending row is left to its delivery, which offers it to every Wait parked
when it scans, and a failed row is left to the resend that reopens it. A Wait that parks
while an arrival's delivery is between its candidate scan and its finish is still offered
that arrival by neither. A Migration's re-park catches up on nothing, since the run was
parked throughout. The read uses the settled index from the run's start, since the inbox
table's indexes are part of what a host's SQL contract leaves alone.
