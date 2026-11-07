# 21. Workflow runs execute on an executor in the application database

Date: 2026-11-05

## Status

Accepted. This decision supersedes ADR-0004 and amends ADR-0011 and ADR-0015.

## Context

Inngest held two roles in Workflow Graph. It was the event bus a host sent Events on, and
it was the durable-execution substrate every run executed inside: it stored the step memo,
fired the timer behind each Wait, retried a failed run, and held the run request between
the send and its pickup. ADR-0004 kept Inngest in the second role because the alternative
it weighed, Effect's workflow module, was marked unstable and needed infrastructure that
Inngest supplied as a service.

Three costs of that second role grew after ADR-0004.

Inngest resumes a function invocation at the last of its outstanding pauses. ADR-0011
answered that wake policy with a durable run per waiting branch. The answer brought a
second registered function, an invoke payload carrying released edges, a kill event, a
parent's sweep of the rows a killed child left open, a claim carried into Canceled-side
branches, and one shape it could not run: a node behind two Waits in different branches.

The application database recorded a run and could not resume one. The step memo, the
scheduled wake, and the edges a completed node released lived only in Inngest. A run whose
request Inngest lost stayed `running` with nothing to sweep it, and a run whose step kept
failing was marked failed in Inngest while its execution row still read `running`.

Every adopter ran an Inngest server or account to execute its runs, including an adopter
that had no other use for an event bus.

The design document `docs/internal/plans/separate-event-intake-from-durable-execution.md`
surveyed the substrates against what the engine needs: a memoized step, a park with a
deadline and a match expression, retries that keep the memo, and a cancellation read at a
step boundary. Workflow Graph ships three persistence backends: long-lived PostgreSQL,
native Node SQLite, and a Cloudflare Worker over Hyperdrive. No TypeScript library covered
all three. DBOS Transact and Effect's workflow module each covered PostgreSQL well, and
each failed at least one of the other two backends.

## Decision

Workflow Graph runs workflows on an executor it owns, stored in the database the
`persistence` option names. Inngest runs no workflow body. Events reach the same executor
through an inbox in that database, which ADR-0022 records.

**A park is a value.** The engine kept its replay model and changed one behaviour.
`waitForEvent` on `WorkflowExecutionRuntime` answers either a wake or that the park is
still open. A parked Wait halts its branch, every other branch runs as far as it can, and
the pass ends with its parks open and writes no terminal record. Any one park's resolution
makes the run due again. One run per Execution therefore holds every branch, and a short
Wait beside a long one resumes at its own target. `scripts/executor-timing.ts` measured
sibling Waits of 2 and 9 seconds, a Cancel while both were parked, and a Wait behind a Wait
by wall clock on both backends. The worst lateness was 9 ms on SQLite and 77 ms on
PostgreSQL.

**Two tables and two wait-row columns hold the durable state,** in both schemas.

- `workflow_execution_schedule` holds one claimable row per in-flight Execution, queued,
  leased or waiting, with the instant the run is next due. The run's terminal write deletes
  it.
- `workflow_execution_steps` is the step memo: one JSON value per durable step, with that
  step's failure count. The terminal write deletes an Execution's memo rows with its
  schedule row.
- A wait row gained the step that parked on it and the wake that resolved it.
- A run-log row gained `released_outlet`, the outlet a completed node released.

**A worker loop advances runs.** `runWorkerLoop` claims due rows with
`FOR UPDATE SKIP LOCKED` on PostgreSQL and under `BEGIN IMMEDIATE` on SQLite, holds each
row under a lease that a heartbeat renews, replays the run body against the memo, and
releases the row as queued, waiting, or deleted. A claim mints an owner token, and every
store write a pass makes checks that token against the schedule row inside the write's own
transaction, so a worker whose lease expired stops at its next write. Each step counts its
own failures against `STEP_RETRY_LIMIT`. A step past its retries fails its node, and the
other branches of the run continue.

**A producer resolves a park in one transaction.** An Event arrival or manual resume, a
Cancel claim, an Exit claim, and a Migration each lock the run's schedule row, write the
wake onto the wait row, and re-queue the run. A pass's release takes the same lock and
re-queues a run whose park holds a wake that no pass read. A start opens the Execution and
writes its schedule row in one transaction. Services reach the executor through
`ExecutionDriver`, which took over the four control-plane sends that `InngestClient` made
to Inngest.

**`createWfGraphApp` runs one worker loop in the host's process by default,** and its
`runner` option tunes that loop or turns it off.

The TLA+ models in `.claude/skills/verify-durable-executor` are the check this design is
held to. They explore every order of the claim, the pass, the release, the producers,
retries, cancellation, the Exit claim and Migration, within stated bounds. Defects they found in the
design include a claim that spent a retry on every wake, a release that
put a run to sleep while a wake that landed during the pass was still unread, retries
counted for the whole run, which left later steps with fewer, and a refused version fence
counted as a failure. Any change to those writes runs the skill's `check.sh`.

## Considered Options

- **Design B, a checkpointed graph walker with no body replay**, deferred. Each node would
  be a job and each completed node's released outlet a column, so nothing would replay. It
  has the better steady state, and it costs a rewrite of the scheduler, the traversal, the
  cancel boundary and the Wait driver, whose claim semantics took months to settle. The
  benefit shows only on very large graphs or hot replays. `released_outlet` was added in
  this change so that path stays open.
- **Design C, the executor behind a port with Inngest kept as a second driver**, rejected
  for the Inngest driver. The port was kept as `ExecutionDriver`. Inngest's wake policy did
  not change, so an Inngest driver would have kept ADR-0011's branch runs, kill event and
  sweep alive.
- **Design D, DBOS Transact as the executor**, rejected. It is PostgreSQL only in
  TypeScript, so the SQLite and Worker backends would have lost their executor. Its
  documentation says it cannot be bundled, which collides with a package that ships a
  bundled `dist`. Its static API allows one application per process, which fits neither
  `createWfGraphApp` nor a per-request Worker host. Its message receive matches by
  destination and topic alone, so the Wait's match expression would have been evaluated
  outside it.
- **Effect's workflow module with a single-node runner**, rejected. The module is still
  tagged unstable in Effect 4.1. Its engine is a cluster of sharded entities that the graph
  scheduler does not need, its shard locks are session advisory locks that Hyperdrive
  forbids, and it has no versioning story. ADR-0004 rejected it for the first reason.
- **Design E, Cloudflare Workflows for the Worker backend**, kept as that backend's
  fallback. It is a managed engine with suitable limits and a second system of record beside
  the adopter's PostgreSQL, with no SQLite or Node form.
- **Self-hosting Inngest**, rejected. Its single-node server is labelled beta, keeps run
  state in Redis, and never reduces to a PostgreSQL the adopter already runs.

## Consequences

Durable run state lives in the adopter's database. The schedule and memo tables hold only
the working set, because the terminal write deletes an Execution's rows in both. The
adopter's backups, capacity and access controls now cover the step memo, which holds
action results. Whether the library prunes run history is a separate question, open in the
design document's section 12.

`createWfGraphApp` takes a `runner` option. Left out, the app runs one loop with the
backend's defaults: concurrency 10 and a 1-second poll on PostgreSQL, concurrency 1 and a
250 ms poll on SQLite, a 60-second lease and a 20-second heartbeat on both, and one slot for
Event deliveries beside the run slots (ADR-0022). `false` runs
no loop in that process, so some other process on the same database has to run one:
`createWfGraphRunner` runs the loop with no HTTP app, on PostgreSQL, and a SQLite app
refuses `false` because no other process can share its file safely. Disposing the app stops its loop and waits up to ten seconds for the passes in
flight.

A producer wakes its own process's loop directly. On PostgreSQL it also announces the run
over `LISTEN` and `NOTIFY` on one channel, sending one notification per 50 ms batch so
that producers' commits keep group commit. The poll finds park deadlines and any wake that
was missed. SQLite loops poll alone, and they run on the host's main thread, because
`node:sqlite` is synchronous.

The Cloudflare Worker host cannot run a loop, since a Worker invocation has no long-lived
process. It runs `tick` instead: drain steps under a budget, one run's pass at a time on
Hyperdrive's one connection. A Cron Trigger every minute runs a tick, which finds park
deadlines with a one-minute resolution, and an optional Queue runs one at once when a
producer's write makes a run due, through a `RunWakeSink` that sends a message. A tick claims
for 10 minutes and interrupts its passes at 14, under the 15-minute wall time of a Cron
Trigger or Queue consumer invocation, and holds its rows under a 5-minute lease renewed
every minute. A Durable Object alarm per run would give sub-minute deadlines and was not
built. Design E stays that backend's fallback.

Events arrive through the event inbox, and the executor delivers them (ADR-0022). The
`inngest` option is still required, because Workflow Graph registers an Inngest function per
name a host Event arrives under, which records each `inngest.send` in the inbox and delivers
nothing itself. Inngest leaves the core in phase 4.

The Inngest functions that ran workflows were deleted, with the run request, cancel,
branch-kill and wait-signal events and the run id Inngest assigned, which the execution
row and the started-run answer used to carry. ADR-0011's branch machinery went with them.
No migration carries an Execution that Inngest held into the executor, because such a run
has no schedule row. An adopter drains in-flight runs before upgrading, under the
no-backwards-compatibility convention in AGENTS.md.

A run whose step exhausts its retries fails that node and ends with a terminal record,
where under Inngest its execution row read `running` forever. Each pass opens its own
`wfgraph.workflow.execution` span, so a run that parks and wakes appears as one trace per
pass.

## Amendment, 2026-11-06: run history is pruned on request

Moving execution into the application database moved run history there too.
`workflow_executions`, `workflow_execution_logs`, `workflow_execution_events` and the
closed `workflow_wait_states` rows grew with every run, in a database the adopter owns and
pays for, with nothing that deleted them.

Workflow Graph gained a host option, `runs: { retentionMs }`, on `createWfGraphApp`,
`createWfGraphRunner` and the `wfWorker` config. It was made off by default, because the
rows are the adopter's audit record and deleting them is a decision about their data that
a library should not make for them. One window covered every terminal status and was
measured from `completed_at`.

The sweep deleted ended Executions, which took their logs, run-scoped audit rows and wait
rows through the existing `ON DELETE CASCADE` keys. It also deleted the workflow-scoped
audit rows that name no run, such as a Refused Start, since nothing else would ever remove
them. Draft snapshots that no Execution referenced went too: a snapshot exists only to be
the graph a Draft run pinned, so once its runs were gone it described nothing. Published
versions stayed, because they are the workflow's version history and the base a builder
compares a draft against, whether or not any run still pins them.

A draft snapshot gained `last_pinned_at`, written each time a Draft run pinned it, and the
sweep deleted only a snapshot whose `last_pinned_at` was older than the window. A Draft run
freezes its snapshot in one transaction and inserts the Execution that pins it in a later
one, so a snapshot reused in between was safe only while the window was far longer than
that gap. Startup refused a run window shorter than one hour for that reason, and refused
either window longer than 100 years, since a larger one put the sweep's cutoff outside the
range a `Date` holds.

A redelivered inbox row is answered from the Execution or the refusal its first delivery
recorded, through `(workflow_id, delivery_id)`. Deleting either while the inbox row could
still be delivered again would have opened a second run for one Event, so the sweep kept an
Execution, and a refusal recorded for a delivery, for as long as that delivery's inbox row
existed. A startup floor refusing a run window shorter than the inbox window was considered
and dropped. It could not cover a pending inbox row, a failed row a resend reopened with its
old `received_at`, settled rows a full inbox batch left behind, or two processes configured
with different windows, and the condition the sweep read from the database covered all
four.

The sweep ran in the upkeep that already swept the inbox: hourly in the worker loop, and on
a Worker's Cron Trigger tick, in batches of 1,000, with the next sweep a poll interval later
when a batch came back full. A sweep the database failed was logged and counted as
finished, so an outage cost one try an hour. That upkeep already ran beside the claims on
every backend and had the cadence, batching and failure handling the run sweep needed, so a
second schedule would have added a second set of timers for the same job. Partial indexes on
`completed_at` and on draft snapshots' `last_pinned_at` served it on both backends. Time
partitioning of the run tables was deferred until volume calls for it.
