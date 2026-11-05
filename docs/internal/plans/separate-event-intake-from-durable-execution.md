# Separate event intake from durable execution

Proposed. Not started. Research and design notes, November 2026.

Inngest plays two roles in Workflow Graph today. It is the event bus a host sends
Events on, and it is the durable-execution substrate every run executes inside.
This document separates the two, proposes a Postgres-backed (and SQLite-backed)
executor the library owns, and turns Inngest into one optional event source
among several. It records what the code depends on today, what the alternatives
offer, the candidate designs, how each candidate behaves under the failure
scenarios that matter, and a recommended path.

## 1. Summary and recommendation

Build the executor; do not buy it. No TypeScript library covers the three
persistence backends this repository ships (long-lived Postgres, native Node
SQLite, Cloudflare Worker over Hyperdrive). The two that cover Postgres well,
DBOS Transact and Effect's workflow module, each bring a replay model and a
process model the graph engine would have to be rewritten around, and each fails
at least one of the other two backends. The survey in section 5 has the details.

The recommended end state has four parts.

1. **A journal-and-scheduler executor in the application database.** Three
   small tables beside the ones that exist: a claimable schedule row per in-flight
   Execution, a step memo keyed by execution and step id, and a resolution slot on
   the existing wait row. Workers claim schedule rows with `FOR UPDATE SKIP LOCKED`
   under a short lease, replay the run body against the memo, and release the row
   as waiting, queued-for-retry, or done. Section 6, Design A.
2. **A park is a value, not a suspension.** The Wait node's `waitForEvent` answers
   `parked` when nothing has resolved the park yet, the branch halts, the
   invocation ends when every branch has either finished or parked, and the
   run resumes when any one park resolves. That single change removes the reason
   ADR-0011 exists: every Wait is entered in place, one durable run per
   Execution, no branch invocations, no kill events, no sweep. Section 6.2.
3. **An event inbox the executor drains.** A host raises an Event with
   `app.events.send`, over an HTTP route, through the existing webhook intake,
   or by inserting into the inbox table inside its own database transaction.
   Delivery fan-out runs as a durable body on the same executor as workflow runs.
   Inngest becomes an event source adapter whose listener functions forward
   into the inbox, so a host already on Inngest keeps its `inngest.send` calls.
   Section 7.
4. **One port, several drivers.** The executor is reached through one Effect
   service. The Postgres and SQLite drivers run an in-process worker loop. The
   Cloudflare Worker driver exposes a bounded `tick` the platform's Cron
   Trigger, a Queue consumer, and optional per-run Durable Object alarms call.
   Section 8.

The order of work is in section 11. The first deliverable is a spike: the
Postgres runtime driving the existing engine test suite through
`driveWithReplay`, with the park-as-value change, measured against the two
timing cases ADR-0011 records. Everything after the spike depends on what it
shows.

## 2. The two roles, as the code has them

The seam the architect wants to cut is already named on one side of the code and
absent on the other.

**The trigger side reaches Inngest through one service.** `InngestClient`
(`packages/core/src/backend/lib/effect/inngest-client.ts`) has five sends, and
every service that talks to the bus goes through it: `sendRunRequested`,
`sendCancelRequested`, `sendWaitSignal`, `sendBranchKill`, `sendCatalogEvent`.
Four of those five are internal control-plane messages from the application to
its own executor. Only `sendCatalogEvent`, which forwards a webhook arrival as a
catalog Event, is a true event-source use.

**The execution side reaches Inngest through one port.** `WorkflowExecutionRuntime`
(`packages/core/src/backend/engine/runtime.ts`) has `run`, `waitForEvent`, an
optional `startBranch`, an optional `wakeParkedWaits`, `attempt` and `runId`.
`createDurableRuntime` in `lib/inngest/workflow-function.ts` is the one place
that fills it from Inngest's step tools. The engine directory imports nothing
from `inngest`; all seventeen importing files sit under `lib/inngest`,
`lib/effect`, `extensions/inngest-options.ts` and `app.ts`.

**What is not separated.** The per-Event listener functions
(`lib/inngest/event-listener-function.ts`) are Inngest functions whose fan-out
runs as memoized `step.run` calls, so "Inngest as the event source" today also
means "Inngest as the durable executor of the delivery." Per-Event flow control
(`rateLimit`, `throttle`, `debounce`, `priority`, `timeouts`, `retries`) is
declared on `defineEvent` and handed to Inngest's `createFunction`. The
`inngest` option on `createWfGraphApp` is required, and the Layer graph takes
the client at construction.

**Inventory of Inngest features in use.**

| Feature                                          | Where                                                                      |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| Event triggers with a CEL `if`                   | one listener per catalog Event; `workflow-run` on `workflow/run.requested` |
| `invoke()` trigger                               | `workflow-branch` is invoke-only                                           |
| `cancelOn` with field-equality CEL               | both run functions; the branch function compares `side` as well            |
| Event `id` idempotency                           | all five sends; the Inngest event id becomes the app's `deliveryId`        |
| `step.run`, `step.waitForEvent`, `step.invoke`   | the three durability primitives the engine uses                            |
| `NonRetriableError`                              | payload gate, missing execution, failed run, unreadable branch answer      |
| Connect mode and HTTP `serve`                    | `app.ts`; the Worker host refuses Connect                                  |
| Run metadata API                                 | `run-metadata` step labels the run in the Inngest UI                       |
| `referenceFunction`, `slugify`, `internalLogger` | branch self-reference, listener ids, log bridge                            |

Not used: `step.sleep` (retired by ADR-0019), `step.sendSignal`,
`step.waitForSignal`, `step.sendEvent`, cron triggers, `batchEvents`, function
`concurrency`. There is no scheduled start anywhere in the code; the
`schedule` start source exists in the vocabulary only.

## 3. What the engine needs from a substrate

The engine's contract, read off the ports and the ADRs, is small.

**Primitives.**

- A memoized step: `run(step, fn)` stores a JSON-safe value under a stable id and
  hands it back on replay. Every `WorkflowStore` write that must happen once sits
  inside one (`engine/durable.ts`).
- A park with a deadline and a match: `waitForEvent(step, { timeoutMs, match })`.
  Both Wait modes park on it; a delay park has a deadline and no token, an event
  park has a token, a deadline (default seven days) and subscribed Event names.
- A retry of the whole body with memo preserved, at most four retries, with a
  non-retriable escape, and an `attempt` counter one step id carries.
- A cancellation that stops a run between steps, which the run reads as a claim
  on the execution row at its next node boundary.

**Behaviours the engine was shaped around.** A replacement reproduces each or
lets the engine drop the machinery built for it.

| Inngest behaviour                                           | Machinery it produced                                                                                                                      | Keep or drop                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Whole-body replay with memo by step id                      | `runDurable` around every once-only write; a fresh `Traversal` per attempt; durations derived in SQL                                       | Keep. Design A reproduces it; Design B drops it.                          |
| JSON round-trip of memoized values                          | `JsonSafe`, ISO strings on every port                                                                                                      | Keep. Any database memo has the same property.                            |
| No step inside a step                                       | handlers cannot suspend; the Wait is unwrapped and memoizes its own segments; routing travels in the outcome                               | Keep. It is the right contract regardless.                                |
| Resume at the last outstanding pause                        | ADR-0011 entire: branch function, invoke payload, kill event, sweep, `readNodeOutputs`, `releasedEdges` on the wire, `markWaitingIfParked` | Drop. An executor the library owns resumes on any resolution.             |
| `cancelOn` kills an invocation without throwing into it     | parent sweeps the child's rows; status poll maps open rows at read time; policy cancel runs no outlet                                      | Drop the kill. Keep the read-time mapping as a backstop.                  |
| No finalizer across a suspension                            | `parkUntil` closes the log row on unwind instead of in a finalizer                                                                         | Drop once a park is a value (section 6.2).                                |
| Async step mode, promises never settled                     | `runInvocation`'s body tracking and dispose semantics                                                                                      | Drop.                                                                     |
| One-second timer resolution, `365d` cap, 1000 steps per run | `WAIT_ATTEMPT_LIMIT`, candidate paging in the listener                                                                                     | Keep the caps as the library's own, chosen on purpose.                    |
| Signals sent before the listener registers are dropped      | `readMissedWake` reads `metadata.arrival` off the wait row                                                                                 | Drop the race. A signal stored in the database first is read by the park. |

## 4. State ownership today

The application database is a faithful record of a run. It is not a resumable
checkpoint. The difference is three gaps.

**In the database already.** `workflow_executions` carries status, the pinned
version, `enqueued_at`, the entity identity, the Cancel and Exit claims and the
terminal verdict. `workflow_execution_logs` carries one row per node attempt with
input, output and error. `workflow_wait_states` carries the wait type, the
`wait_until` target, the resume token, the subscribed Event names, the compiled
match, the anchor instant, the claim lease and any arrival already claimed onto
the row. `workflow_execution_events` is the timeline, `workflow_event_subscriptions`
the Event-to-workflow index.

**Only in Inngest.**

1. The step memo for every id listed in ADR-0015: admission booleans, Entity
   snapshots, handler sub-step results, wait prepare and resume values, terminal
   record outcomes.
2. The scheduled wake. The target instant is on the wait row; the thing that
   fires at that instant is Inngest's timer. No app process polls `wait_until`.
3. Which outgoing edges a completed node released. A Condition's output is on its
   log row, but the traversal's `releasedEdges` exist only in memory and on
   branch invoke payloads.

Also Inngest-only: the parent-to-branch relation, the attempt counter, the retry
backoff, the in-flight event queue between `send` and pickup, and the host-event
fan-out. A row stuck as `running` whose `workflow/run.requested` event Inngest
lost is swept by nothing; `reclaimStuckRuns` touches only rows whose
`enqueued_at` is null.

A Postgres-backed executor adds exactly the three gaps: a memo table, a schedule
row with a wake time, and either replay (which rebuilds released edges from
memoized Condition outputs) or a persisted cursor.

## 5. Alternatives surveyed

Primary sources were read for each option; the URLs are in section 13.

| Option                                     | Shape                                                           | Storage                                                    | Postgres           | SQLite in TS    | Workers             | Verdict                                           |
| ------------------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------- | ------------------ | --------------- | ------------------- | ------------------------------------------------- |
| DBOS Transact TS 5.4                       | in-process library, own `dbos` schema, process-global singleton | Postgres only                                              | yes                | no (open issue) | no                  | closest buy; see below                            |
| Absurd 0.5                                 | one SQL file plus thin SDK, pull workers                        | Postgres only                                              | yes                | no              | no                  | reference design, not a dependency                |
| Effect 4 workflow + cluster `SingleRunner` | Effect services, two or three cluster tables                    | any `SqlClient`                                            | yes                | driver exists   | runner undocumented | unstable tag; cluster abstraction; advisory locks |
| Vercel Workflow DevKit                     | build-time directives, execution over the host's HTTP routes    | Postgres World on graphile-worker                          | reference only     | no              | no                  | wrong shape for a library                         |
| pg-boss 12                                 | job queue, own `pgboss` schema                                  | Postgres, PGlite                                           | yes                | no              | no                  | good spec for lease semantics; Postgres only      |
| graphile-worker 0.18                       | job queue                                                       | Postgres                                                   | yes                | no              | no                  | four-hour stale lock without the paid tier        |
| Hatchet                                    | Go control plane plus gRPC workers                              | Postgres, optional RabbitMQ                                | server             | n/a             | no                  | not embeddable; best event-wait reference         |
| Restate                                    | stateful server, pushes to your HTTP                            | own log plus RocksDB                                       | no                 | n/a             | no                  | wrong storage, BSL                                |
| Temporal                                   | four-service cluster, native SDK                                | Cassandra, MySQL, Postgres                                 | server             | dev only        | no                  | install footprint is a cluster                    |
| Inngest self-hosted                        | beta single-node Go server                                      | SQLite plus embedded Redis; production Redis plus Postgres | run state in Redis | n/a             | serve yes           | never reduces to "a Postgres"                     |
| Cloudflare Workflows                       | managed engine                                                  | managed                                                    | n/a                | n/a             | native              | a second system of record                         |

**DBOS deserves the longest look because it is the strongest buy.** It is MIT,
in-process, mature, and its primitive set covers sleep, send and receive, child
workflows with deterministic ids, cancellation at the next step boundary,
queues, cron, and `fork(startStep, applicationVersion)` plus `patch()` for
moving a parked run to new code. Four things rule it out here. It is Postgres
only in TypeScript, so the SQLite backend and the Worker backend lose their
executor. The library "cannot be bundled with JavaScript or TypeScript bundlers
... and must be treated as an external library", which collides with a package
that ships `dist` through tsdown. It is a process-global static API with one
application name per process, awkward behind `createWfGraphApp` and impossible
for the per-request Worker host. And its `recv` matches by destination and topic
only, so the Wait node's match expression would be evaluated outside it, which
is most of the Wait machinery written twice. Cross-process crash recovery
without the paid Conductor is the operator's job.

**Effect's workflow module is the one option that speaks this repository's
language**, and `SingleRunner.layer` gives a single-node Postgres install in two
or three tables. Against it: the module is tagged `unstable` in Effect 4.1, the
release-candidate month fixed "lost durable deferred wakes" and "workflow
execution ID collisions", the engine is a cluster of sharded entities and
mailboxes the graph scheduler does not need, shard locks are session advisory
locks that Hyperdrive forbids, replay re-runs every non-activity line, and it has
no versioning story. ADR-0004 rejected it for the first of those reasons and the
reasons have not changed. The reusable idea is its `WorkflowEngine.Encoded`
contract (`register, execute, poll, interrupt, resume, activityExecute,
deferredResult, deferredDone, scheduleClock`), a small engine port shape worth
borrowing from.

**Absurd is the reference design.** Its single SQL file encodes the invariants a
home-grown journal needs: a claim that sweeps expired leases in the same
statement, checkpoints keyed by name with an attempt guard on overwrite,
first-write-wins cached events so a wait registered after the emit still reads
it, cancellation observed at the next step, and a fixed lock order between
cancel, complete and fail. Its production retrospective is a checklist of what
went wrong first. It stays a reference because it is 0.x, Postgres only, owns
per-queue tables, and lacks cron, match expressions and migration.

**Keeping Inngest but self-hosting** means the adopter runs a Go server whose
single-node mode is labelled beta, with run state in embedded or external Redis,
under SSPL, with no vendor support, reachable over HTTP or through beta Connect.
That is the status quo's cost, stated so the build is measured against it.

## 6. Candidate executor designs

Four designs were worked through. A and B are the two end states; C is the
staging between them; D and E are the comparison points.

### 6.1 Design A: a replay runtime over the application database

The engine keeps its replay model. The executor reproduces what Inngest does with
the step memo, the timers and the queue, in three tables, and changes two engine
behaviours on purpose: a park is a value, and a run wakes on any resolution.

**Tables.** Each is the one home of its concept, folded onto an existing
aggregate where one exists.

```sql
-- One claimable row per in-flight Execution. Deleted at the terminal write,
-- so the table holds the working set and its partial index stays tiny.
create table workflow_execution_schedule (
  execution_id      text primary key references workflow_executions(id) on delete cascade,
  kind              text not null,            -- 'run' | 'delivery' (section 7)
  state             text not null,            -- 'queued' | 'leased' | 'waiting'
  wake_at           timestamptz not null,     -- queued: now or the retry backoff; waiting: the earliest park deadline
  attempt           integer not null default 0,
  lease_expires_at  timestamptz,
  owner_token       text,                     -- fencing token; cleared on release, cancel and migration
  worker_id         text,
  last_error        text
);
create index workflow_execution_schedule_due_idx
  on workflow_execution_schedule (wake_at, execution_id) where state in ('queued', 'waiting');
create index workflow_execution_schedule_lease_idx
  on workflow_execution_schedule (lease_expires_at) where state = 'leased';

-- The step memo. One row per durable step; the value is the JSON the engine
-- already round-trips. Written in the same transaction as the step's own store
-- write wherever the step has one.
create table workflow_execution_steps (
  execution_id  text not null references workflow_executions(id) on delete cascade,
  step_id       text not null,
  attempt       integer not null,
  value         jsonb,
  created_at    timestamptz not null default now(),
  primary key (execution_id, step_id)
);

-- The existing wait row gains the park's resolution. `arrival` already lives
-- in metadata; it becomes a column, beside the step that parked and the wake it
-- resolved to.
alter table workflow_wait_states
  add column park_step_id text,
  add column wake jsonb;                      -- null while parked; {kind: timeout|resume|cancel|exit|migrate, ...} once resolved
```

SQLite gets the same three shapes with epoch-millisecond integers and JSON text,
the way the existing SQLite schema mirrors Postgres.

**The invocation.** One worker pass over one schedule row.

1. Claim. One statement: a locking CTE over `workflow_execution_schedule` where
   `state in ('queued','waiting') and wake_at <= now()`, ordered by `wake_at`,
   `FOR UPDATE SKIP LOCKED`, then `update ... set state = 'leased', owner_token =
   <new>, lease_expires_at = now() + <lease>, attempt = attempt + (state = 'queued')`.
   A `waiting` row claimed because `wake_at` passed is a timed-out park, and the
   claim resolves that park as `{ kind: "timeout" }` in the same transaction. On
   SQLite the claim is an `UPDATE ... WHERE execution_id IN (SELECT ... LIMIT n)
   RETURNING` under `BEGIN IMMEDIATE`; one writer needs no `SKIP LOCKED`.
2. Load. The execution row and its pinned version, as `loadPersistedRunInput`
   does today, plus every `workflow_execution_steps` row for the execution in one
   query, into a `Map<stepId, value>`.
3. Run. `executeWorkflow(input, runtime, store, actions, entities)` with the
   runtime below. The body replays from the top; memo hits return in memory.
4. Release. The body's outcome decides the row: deleted when the terminal record
   was written; `queued` with `wake_at = now()` when any of the run's wait rows
   holds a wake the pass did not consume; `waiting` with
   `wake_at = min(deadline over open parks)` when the body ended with at least
   one park outstanding and no unconsumed wake; `queued` with
   `wake_at = now() + backoff(attempt)` when a step body threw a retriable error
   and `attempt < 4`; terminal `failed` written through the store when the
   retries are spent. The last case is new behaviour: today a run whose step
   keeps failing is marked failed by Inngest and the execution row reads
   `running` forever.

**The runtime.**

- `run(step, fn)`: memo hit returns the value. Otherwise run `fn`, then insert
  the memo row in a transaction that first checks `owner_token` on the schedule
  row. A mismatch means the lease was lost (a slower worker, a cancel, a
  migration); the write is refused and the invocation stops without recording
  anything. That check is the fencing token DBOS calls the ownership token and
  Restate calls the attempt epoch; the lease alone gives liveness, the token gives
  safety.
- `waitForEvent(step, options)`: if the wait row for this park carries a `wake`,
  return it. Otherwise record `park_step_id` on the wait row (the Wait node's
  prepare step created the row already, with `wait_until` and the subscribed
  Events) and answer `{ parked: true }`.
- `attempt` comes from the schedule row. `startBranch` and `wakeParkedWaits` are
  absent. The engine already enters every Wait in place when `startBranch` is
  absent, and the Exit wake becomes a direct resolution of sibling parks (below).

**Resolving a park.** Every producer that sends a `workflow/wait.signal` today
instead writes the wake onto the wait row and re-queues the execution, in one
transaction:

```sql
update workflow_wait_states
   set wake = $wake, status = 'resuming'
 where id = $waitStateId and status = 'waiting';          -- conditional: one wake per park
update workflow_execution_schedule
   set state = 'queued', wake_at = now()
 where execution_id = $executionId and state = 'waiting';  -- a leased run reads the row on its next pass
```

The producers are the ones that exist: `wakeWait` for an Event arrival or a
manual resume, `signalParkedWaits` for `lifecycle-cancel` and `lifecycle-exit`,
`migrateExecutions` for `version-migrate`. The claim they already take on the
row (`claimWaitState`, with its five-minute lease and `allowSameDeliveryRetry`)
stays; what changes is that the second half is a row write instead of a send.

A wake that lands while the run is `leased` leaves the schedule row alone, so
the release is what has to notice it. The pass may already have read that Wait
as parked, and a release that wrote `waiting` from the pass's own view would put
the run to sleep with a woken branch nobody runs. That branch then waits for the
next deadline of some other open park, and when no other park is open the run
has no `wake_at` at all and sleeps until a cancel. A TLA+ model of this executor
(one run, two parallel Waits, two workers) reaches that state in four steps:
claim, park both, wake one during the pass, release. The release therefore takes
the schedule row's lock and then reads the run's wait rows in the same
transaction, writing `queued` when any holds an unconsumed wake. Both writers
lock the schedule row, so either the producer commits first and the release sees
its wake, or the release commits first and the producer finds `waiting` and
re-queues. With that release the model holds the rule in every reachable state.
The "signal sent before the listener registered" race in
`signal-parked-waits.ts` disappears, because the park reads the row.

**Retries.** A step body that throws a retriable error ends the invocation. The
release writes `queued` with a backoff and the attempt counter; the memo keeps
every step that completed. A `StepFailure` keeps travelling as a value
(ADR-0009) so a refused vendor call fails the node once. A non-retriable failure
writes the terminal record through the store and deletes the schedule row.

**Cancellation.** A Cancel Event writes the claim on the execution row (exists),
resolves every open park on the Started side as `{ kind: "cancel" }` and
re-queues (replaces `sendBranchKill` plus `signalParkedWaits`). The replayed body
reads the claim at its next `lifecycle-check` step and routes the Canceled
outlet, which is what it does today after a kill. A policy cancel (the manual
button, supersede, a refused enqueue) writes the terminal status (exists),
deletes the schedule row, clears `owner_token`, and resolves parks as cancelled.
A leased invocation of that run fails its next fenced write and stops.

**Migration.** `repinVersion` (exists) plus a `{ kind: "migrate" }` wake on each
parked row plus a re-queue. The replay loads the new version, the Wait driver's
attempt loop sees the `migrate` wake and prepares again (exists, ADR-0019). The
version fences on `createWaitState`, `reparkWaitState` and
`markExecutionRunning` keep working unchanged; a refused fence ends the
invocation as a retry, which reloads the newer graph, which is the behaviour
ADR-0019 describes.

**Exit claim.** The run that wins `requestExit` resolves its own sibling parks
as `{ kind: "exit" }` inside the same step. With one run per Execution the
siblings are branches of the same invocation; their parks resolve on the next
pass and halt, which is what `wakeParkedWaits` achieves across invocations today.

**Lease and liveness.** Lease sixty seconds, heartbeat every twenty from the
worker while a step body runs, renewed on every memo write. An expired lease is
swept inside the claim statement, bounded to the batch size, and the swept row is
re-queued with its attempt counted, the way Absurd's `claim_task` fails the run
with `$ClaimTimeout`. The lease is shorter than any platform kill timeout
(section 8), and the fencing token makes a lease that expired under a worker that
was merely slow a harmless duplicate attempt rather than a duplicate side effect.

**Wake latency.** Postgres: `LISTEN` on one channel, with `NOTIFY` issued by the
re-queue write and debounced per process, and a one-second poll as the backstop.
The notify is an optimisation only; timers always need the poll, and the recall.ai
and DBOS write-ups show `NOTIFY` under many concurrent committers serialising
commits, so it is batched per transaction and never per row. SQLite: an
in-process ticker at two hundred and fifty milliseconds. Worker: section 8.

**What Design A changes in the engine.** Two things, both small.

- `WaitOutcome` gains a `parked` state (section 6.2). `executeWorkflow` ends with
  "parked" instead of a terminal record when any branch parked, the way
  `executeWorkflowBranch` already ends with `markWaitingIfParked`.
- `drainDeferredWaits` keeps holding Waits back until the fan-out settles, which
  stays correct and now costs nothing, since a parked branch no longer parks its
  siblings.

Everything under ADR-0011 is deleted: `executeWorkflowBranch`,
`createWorkflowBranchFunction`, `workflowBranchInputSchema`, the kill event,
`handOffBranch`, `sweepKilledBranchWork`, `restoreCompletedNodeProgress`,
`readNodeOutputs`, `readCompletedNodeProgress`, `releasedEdges` on the wire,
`isCancelledInvocation`, and the `branch-*` step ids. The node-behind-two-Waits
case ADR-0011 leaves open is answered: both parks resolve in their own passes,
each replay rebuilds one traversal, and the AND-join becomes ready in the pass
that completes the second predecessor.

### 6.2 A park is a value

This is the one engine decision the rest of the design rests on, so it is stated
on its own.

Today `waitForEvent` returns a Promise Inngest never settles. The invocation is
abandoned, the SDK reports the planned park, and the body is re-run later. The
in-memory runtime models the same by resolving immediately with a stand-in, and
`driveWithReplay` models it by abandoning the body at each undiscovered step. The
engine therefore already tolerates "the body ends here and runs again from the
top".

The proposal makes the abandonment explicit. `waitForEvent` answers one of two
JSON-safe values: the wake, or `{ parked: true }`. The Wait driver, on `parked`,
returns a `WaitOutcome` whose `haltBranch` is true and whose node result is left
unrecorded, so the traversal does not mark the node completed. The scheduler
treats it as it treats any halted branch: nothing below is scheduled. The
invocation runs every other branch as far as it can, `drainDeferredWaits` enters
the remaining Waits, each either resumes or parks, and `executeWorkflow` returns
with `{ parked: n }` when `n > 0`, writing no terminal record. The executor
releases the schedule row as waiting.

Three consequences.

1. No fiber is ever interrupted to suspend a run, so the scheduler's
   `catchCause` attribution boundary, which would otherwise read an interrupt as
   a node failure, is never exercised by a park. `parkUntil` and the
   "no finalizer across a suspension" rule go.
2. Parallel branches cost nothing extra. Two sibling Waits at twenty and ninety
   seconds park in one pass; the twenty-second branch resumes in a pass at
   twenty seconds while the other row stays parked; the ninety-second branch
   resumes at ninety. That is the ADR-0011 measurement, achieved with one run.
3. Replay cost is bounded by the graph. A pass is one query for the memo, one for
   the execution and version, and an in-memory walk where every completed step is
   a Map hit. A fifty-node graph holds on the order of two hundred and fifty memo
   rows. The pass is cheaper than the Inngest round trips it replaces.

### 6.3 Design B: a checkpointed graph walker, no body replay

The graph is data, so the executor can treat each node as a job and persist the
cursor instead of replaying code. This is what Hatchet's v1 engine does for its
DAGs, and it is the model ADR-0011 already reached for when a branch run
"inherits the outputs above its entry node from the store".

- `workflow_execution_logs` gains `released_outlet` and `arriving_event`, so a
  completed row says which edge it released and which Event the branch below it
  is on. The three Inngest-only gaps of section 4 close without a memo of
  admission decisions, because the decisions become rows.
- A node is a job: the schedule table holds `(execution_id, node_id)` rows. A
  completed node inserts the jobs of its ready successors; an AND-join's
  readiness is a query over predecessor rows, made atomic by a unique
  `(execution_id, node_id)` claim row, which closes the two-branches-reach-one-join
  race for good.
- A Wait is its own row, as today; a wake inserts the successor jobs. Nothing
  replays.
- Handler sub-steps (`step.run` inside a handler, ADR-0009) still need a memo,
  keyed `(execution_id, node_id, step_id)`, and a node-level retry replays the
  handler body alone.

Design B has the better steady state: no replay, exact per-node retries, branches
of one run executable on different workers, memory per pass bounded by one node.
It costs a rewrite of `scheduler.ts`, `traversal.ts`, `cancel-boundary.ts` and
the Wait driver, roughly four thousand lines whose claim semantics took months to
get right, and a new conformance suite for the cursor rows. The benefit shows
only at scale (very large graphs, or hot replays). Design A reaches the same
observable behaviour with the engine intact, so Design B is the destination to
keep open, not the first step. Keeping `released_outlet` on the log row from the
start is cheap and is the one Design B column worth adding in Design A, because it
also fixes the "a row cannot say whether a node selected an outgoing edge" gap for
the Runs view.

### 6.4 Design C: Design A behind a driver port, Inngest kept as a driver

Same as Design A, with the executor behind one Effect service so that the Inngest
adapter remains a second implementation during the transition and, if wanted,
for hosts that cannot run a worker. The port:

```ts
class ExecutionDriver extends Context.Service<
  ExecutionDriver,
  {
    // enqueue a run body for this execution; idempotent on execution id
    readonly enqueueRun: (input: {
      executionId: string;
    }) => Effect.Effect<void, DriverError>;
    // write a wake onto a parked row and re-queue the run
    readonly resolvePark: (input: {
      executionId: string;
      waitStateId: string;
      wake: WaitWake;
    }) => Effect.Effect<void, DriverError>;
    // stop a run: clear its lease token, resolve its parks as cancelled, drop its schedule row
    readonly stopRun: (input: {
      executionId: string;
    }) => Effect.Effect<void, DriverError>;
    // enqueue a delivery body for an inbox row (section 7)
    readonly enqueueDelivery: (input: {
      eventId: string;
    }) => Effect.Effect<void, DriverError>;
  }
>()("@wfgraph/core/ExecutionDriver") {}
```

This is `InngestClient` with its five sends renamed by intent. The Inngest driver
maps `resolvePark` to `sendWaitSignal` and `stopRun` to the two cancel sends. The
Postgres driver maps them to the row writes of section 6.1. Keeping both alive
for one release lets the reliability suite (`pnpm run test:reliability`) run
each case on both drivers and diff the outcomes, which is the strongest
verification available before the Inngest driver is deleted.

Whether the Inngest driver survives past the transition is a product question
(section 12). If it does, it is the one case where ADR-0011's branch machinery
must stay, because Inngest's wake policy has not changed. The cost of keeping
two drivers is the cost of keeping ADR-0011. The recommendation is to delete it.

### 6.5 Design D: DBOS as the executor

For completeness. `DBOS.registerWorkflow` would wrap `executeWorkflow`;
`runtime.run` maps to `DBOS.runStep`, `waitForEvent` to `DBOS.recv` on a topic
named by execution and node, with the match expression evaluated in the engine
before the send, a branch to a child workflow with a deterministic id,
cancellation to `cancelWorkflow`. It is the fastest path to a Postgres-only
executor on Node. It is ruled out by the four constraints in section 5: no
SQLite, no Worker, a global singleton, and the bundler rule.

### 6.6 Design E: Cloudflare Workflows for the Worker backend

A Worker host could run the engine on Cloudflare Workflows, with `step.do`,
`step.sleep` to three hundred and sixty-five days, `step.waitForEvent` with a
typed timeout, and `restart({ from })`. It is a managed engine with the right
limits and a second system of record beside the adopter's Postgres, and it has
no SQLite or Node form. It is the comparison point for section 8's Worker driver:
if the tick-based driver proves too slow for a Worker host, this is the fallback
for that backend alone.

## 7. The intake side

The user-facing question is "how does a host raise an Event", and the
architectural question is "what is the durable record of an arrival". Today the
answer to both is Inngest.

### 7.1 The inbox

```sql
create table workflow_event_inbox (
  id              text primary key,
  name            text not null,
  data            jsonb not null,
  connection_id   text,                     -- integration Events arrive through a Connection
  idempotency_key text,                     -- host-chosen; unique per name
  received_at     timestamptz not null default now(),
  delivered_at    timestamptz,
  unique (name, idempotency_key)
);
```

An inbox row is the arrival. It replaces the Inngest event as the thing the
`deliveryId` names: `workflow_executions.delivery_id` and the unique index
`(workflow_id, delivery_id)` keep working with the inbox id in place of the
Inngest event id, and `answerFromCommittedDecision` keeps making a retried
delivery idempotent.

### 7.2 Delivery is a durable body on the executor

`runEventListener` already takes a `step` port with one verb, `run`, and fans
out through memoized steps named `subscribers-*`, `lifecycle-*`,
`wait-candidates-*` and `waits-*`. It becomes the second kind of body the
executor runs: a schedule row with `kind = 'delivery'` and the inbox id, claimed
and leased the same way, with the same memo table keyed by the inbox id. One
queue, one lease, one memo, two bodies. The per-Event retry count moves from
`inngest.retries` to a column on the Event definition the driver reads.

### 7.3 Sources

A source is anything that inserts an inbox row and enqueues its delivery.

- **`app.events.send({ name, data, id? })`** on `WfGraphApp`, which is the API
  `docs/events.md` currently writes as `inngest.send`. Validated against the
  catalog at the boundary.
- **`POST {basePath}/api/events`** on the machine routes, authenticated by a
  shared signing key the way the Inngest callback is today, for a host whose
  producer is a different process or language.
- **Webhook intake** (exists). `receiveWebhook` calls `send` instead of
  `sendCatalogEvent`; the Connection id becomes a column instead of a stamped
  payload key, which removes `catalog-connection.ts`.
- **A host's own transaction.** A host that shares the database can insert the
  inbox row inside the transaction that produced the business fact, which is the
  transactional outbox the host cannot get from any external bus. The executor
  picks it up on its poll. This is worth documenting as a first-class pattern;
  it is the strongest argument for the inbox over any external bus.
- **The Inngest source.** An entry (`@wfgraph/core/inngest`, or a package) that
  builds one Inngest function per catalog Event whose body is one `send`. A host
  already on Inngest keeps its `inngest.send` calls and its Inngest-side
  idempotency, and Workflow Graph's own durability starts at the inbox row. The
  `inngest` peer dependency moves to that entry.
- **Cron.** There is no scheduled start today. With the executor owning a
  scheduler, a `workflow_schedules` table with `next_fire_at` and a
  compare-and-swap enqueue (`update ... where last_enqueued_at is not distinct
  from $seen returning`, then insert the inbox row with idempotency key
  `name:fire_time`) adds it at low cost. It is a product decision whether to.

### 7.4 Per-Event flow control

`defineEvent` lets an Event Author declare Inngest's `rateLimit`, `throttle`,
`debounce`, `priority`, `timeouts` and `retries`, with `batchEvents` and
`concurrency` refused. Without Inngest each needs an owner.

- `retries` and `timeouts`: columns the delivery body reads. Straightforward.
- `priority`: a column on the schedule row and a term in the claim's `ORDER BY`.
  Straightforward.
- `debounce` by key: the delivery row is held with `wake_at = received_at +
  period` and re-pointed at the newest inbox row for the key while it waits; one
  conditional update per arrival. Moderate.
- `throttle` and `rateLimit` by key: a token-bucket row per key, consumed inside
  the claim. Moderate, and the only part of Inngest's flow control that is hard
  to get exactly right under many workers.

Whether any adopter uses the last two is unknown and decides whether they ship in
the first release or are dropped from `defineEvent` under the no-backwards-
compatibility convention. Section 12 lists it.

## 8. Deployment topologies

The executor needs something to tick it. Each backend has a different answer.

**Long-lived Node, Postgres.** The default. `createWfGraphApp` starts a worker
loop in-process when `worker` is set (concurrency, poll interval, lease), which
is the same process shape `inngest.connect: true` requires today. A
`createWfGraphWorker` entry runs the loop with no HTTP app for hosts that want
dedicated workers. Multiple processes scale by `SKIP LOCKED`; the claim is one
statement, the claim transaction commits in milliseconds, and nothing holds a
transaction across a step body. Table settings that the Postgres queue literature
agrees on: partial indexes on the claimable rows only, per-table autovacuum at a
fixed threshold rather than a scale factor, `fillfactor` around seventy on the
schedule table so lease renewals are heap-only updates, and
`idle_in_transaction_session_timeout` set. Memo rows of terminal executions are
deleted with the schedule row or kept under a retention sweep; the Runs view
reads log rows, not the memo.

**SQLite.** One process, one writer. The loop is a ticker in the same process as
the HTTP app, every claim is `BEGIN IMMEDIATE` and returns in microseconds, and
step bodies run outside any transaction. `node:sqlite` is synchronous, so a claim
blocks the event loop for its duration, which is why the transaction holds
nothing but the row flip. No `LISTEN`; the ticker is the wake. Multi-process
SQLite is unsupported, as it effectively is today.

**Cloudflare Worker over Hyperdrive.** No long-lived process, no `LISTEN`, no
session advisory locks, transaction-level locks only inside an explicit
transaction, a fifteen-minute wall budget per cron, queue or alarm invocation,
and a sixty-second statement limit. The driver exposes `tick({ budgetMs })`: claim
a bounded batch with a lease shorter than the platform budget (five minutes),
run passes until the budget is near, release, return. Three platform clocks call
it.

- A Cron Trigger every minute drains due rows. This alone gives timers a
  one-minute resolution and starts a one-minute delay.
- A Queue consumer gives immediate wakes: `send` and every park resolution also
  enqueue a message naming the execution, and the consumer ticks that one row.
  `delaySeconds` caps at twenty-four hours, so long sleeps stay rows the cron
  sweeps.
- A Durable Object per Execution, optional, whose single alarm is the run's next
  `wake_at`, gives sub-minute timer resolution without a cron sweep. One DO per
  run is within platform limits.

The Worker driver is the most work and the least certain. It should be the last
driver written, after the Postgres and SQLite drivers have proven the tables, and
Design E remains its fallback.

**Vercel and Lambda.** The same `tick` under a Vercel cron (best effort, may
double-fire, hence the lease) or EventBridge Scheduler, within the function's
`maxDuration`. Not a target today; noted so the driver's shape is not Cloudflare-
specific.

## 9. Scenarios

Each scenario is walked under Design A unless stated. "Today" means Inngest.

**S1. Linear run, worker dies mid-step.** The lease expires in sixty seconds. The
next claim sweeps the row back to `queued` with the attempt counted. A worker
replays: every completed step is a memo hit; the step that was running re-runs.
At-least-once at the step, the same as today; an idempotency key on the vendor
call is still the handler's job (ADR-0009). Difference from today: detection is
the lease, not Inngest's own timeout.

**S2. Two sibling Waits, twenty and ninety seconds.** One pass parks both; the
row waits with `wake_at` at twenty seconds. At twenty the claim resolves the
first park as a timeout and the pass runs the short branch, parks the long one
again (memo hit on the prepare, the park row still waiting), releases with
`wake_at` at ninety. At ninety the long branch runs. Two passes, one run, the
timings ADR-0011 measured, with none of ADR-0011's machinery.

**S3. Cancel Event while both are parked.** The claim is written, both parks are
resolved as cancel, the row is re-queued. The pass replays, each Wait's attempt
reads the cancel wake and halts, the run reads the claim at the boundary step,
enters the Canceled outlet, and a Canceled-side Wait parks in the same pass. Today
this takes a kill event, a parent sweep and a Canceled-side branch invocation.

**S4. Event arrival races a timeout.** Two writers: the claim statement that
resolves the park as a timeout because `wake_at` passed, and `wakeWait` writing a
resume. Both are conditional on `status = 'waiting'`; one wins. If the timeout
wins, `settleWaitTimeout` (exists) still reads an arrival claimed in the window
and turns it into a resume, which is the same race the engine closes today.

**S5. Event arrives before the park is registered.** Today the signal is dropped
and the park reads `metadata.arrival` as a fallback. With the inbox, the delivery
body claims the wait row, writes the wake, and the park reads the row whether it
registered before or after. The race no longer exists.

**S6. Migration of a parked run.** `repinVersion` plus a migrate wake plus a
re-queue. The pass loads the new graph; the Wait driver re-prepares against it
under the attempt-indexed step ids (exists). A migration landing while a pass is
between loading the version and parking fails the fence, ends the pass as a retry,
and the next pass loads the newer graph, the behaviour ADR-0019 describes.

**S7. Two workers claim the same run.** Impossible under `SKIP LOCKED` while the
lease holds. After an expiry under a worker that is slow rather than dead, both
hold the execution; the slow one's next memo write fails the `owner_token` check
and it stops. Its step body may have run twice, which is S1's at-least-once.

**S8. Deploy during a long sleep.** The run pins its graph version and its memo
rows carry the step ids of the engine that wrote them. A compatible engine resumes
it (ADR-0015). An incompatible step-id change still strands parked runs, as it
does today, and the epoch mechanism ADR-0015 defers is unchanged in shape; the
executor makes it easier to implement, since an epoch becomes a column on the
schedule row the claim filters on rather than a second set of registered
functions.

**S9. Burst of ten thousand Events.** Ten thousand inbox rows and ten thousand
delivery rows. Each delivery is one pass with a handful of memo writes; a workflow
with one hundred subscribers and parked waits pages candidates exactly as today.
Rough capacity: a node costs about five short write transactions (boundary, log
open, handler step, log close, lifecycle check), a delivery about three plus one
per subscriber. A modest Postgres sustaining several thousand small transactions
per second therefore runs on the order of a thousand node executions per second
before any tuning, which is above where Inngest's own per-step round trips land
today. Beyond that, the levers are batching memo writes per pass and
partitioning terminal history.

**S10. SQLite in the example app.** One process, the ticker claims, the pass runs,
the writes are `BEGIN IMMEDIATE`. `pnpm run dev` drops the Inngest CLI and its
four ports. The reliability suite's SQLite leg runs with no spawned server.

**S11. Worker host.** A `send` from a request handler inserts the inbox row,
enqueues a queue message, and returns. The consumer ticks the delivery, which
opens the Execution and enqueues its first pass; the consumer ticks that too.
Timers resolve on the minute cron or on a DO alarm. A long step is bounded by the
five-minute lease inside the fifteen-minute invocation. Latency for an
event-driven start is sub-second through the queue; for a delay Wait it is the
cron minute unless alarms are enabled.

**S12. Database failover.** Asynchronous replication can lose the last commits,
so a run can regress to an earlier memo. Every memo write is a step that is safe
to repeat, which is the same invariant at-least-once already demands. `LISTEN`
connections drop; the poll covers it. Today the same event loses whatever
Inngest had not durably recorded, which the application cannot see at all.

**S13. Host restarts with in-flight runs.** Nothing is lost: the schedule rows
and memo are in the database, and the next worker pass continues them. Today the
same holds through Inngest, with the one gap that a `workflow/run.requested` lost
between `send` and pickup leaves a row `running` forever; with the schedule row
written in the same transaction as the execution row, that gap closes.

**S14. "What is this run waiting on."** `workflow_execution_schedule.state`,
`wake_at`, `attempt`, `lease_expires_at`, `worker_id`, `last_error`, joined to
the open wait rows' `park_step_id`, `wait_until` and `subscribed_events`. The
Runs view can show attempt, lease and next wake, which no Inngest-side fact is
available for today.

## 10. Risks

- **Replay correctness in the engine.** The park-as-value change touches the Wait
  driver, `executeWorkflow`'s exit and the scheduler's halt path. The existing
  replay tests (`driveWithReplay`, the eight engine suites) are the safety net,
  and they already model abandonment at every undiscovered step. The spike runs
  them unchanged against the new runtime before any engine edit.
- **Memo write amplification.** Five writes per node is fine at the scale this
  product runs at; it is the number to watch. The Design B cursor model is the
  answer if it becomes the bottleneck.
- **The Worker driver.** The least certain piece and the easiest to defer.
- **Flow control.** `debounce`, `throttle` and `rateLimit` under many workers are
  real distributed-systems work; the honest first release ships `retries`,
  `timeouts`, `priority` and `debounce`, and decides the other two with data.
- **Two drivers during transition.** Keeping the Inngest driver alive for one
  release keeps ADR-0011 alive for one release. The diffing it enables through
  the reliability suite is worth it; carrying it longer is not.
- **Public contract.** `createWfGraphApp`'s required `inngest` option becomes
  optional and then goes; `docs/events.md`, both published skills, the example
  app and the peer dependency change. One major version under the fixed group.

## 11. Recommended path

Each phase ends green against the AGENTS.md check list.

1. **Spike (time-boxed).** A Postgres driver and a SQLite driver for
   `WorkflowExecutionRuntime` in a scratch branch, plus park-as-value. Drive the
   eight engine replay suites and the ADR-0011 timing cases through them. Exit
   criterion: the suites pass unchanged, and S2 measures within a second of the
   targets on both backends.
2. **The port.** `ExecutionDriver` replaces `InngestClient` in `WfGraphServices`;
   the Inngest driver is its first implementation and nothing observable changes.
   The reliability suite runs on it.
3. **The executor.** Schedule, memo and wake columns in both schemas; the worker
   loop; the Postgres and SQLite drivers behind the port; `executeWorkflow` ends
   with `parked`. The reliability suite runs on both drivers and diffs.
4. **The inbox.** `workflow_event_inbox`, delivery bodies on the executor,
   `app.events.send`, the HTTP route, webhook intake rewired, the Inngest source
   entry. `defineEvent` flow control re-homed as section 7.4 describes.
5. **Retire ADR-0011 and the Inngest driver.** Delete the branch function, kill
   event, sweep and progress restore; `inngest` leaves `createWfGraphApp` and the
   peer dependency; `scripts/dev.ts` drops the CLI. New ADR superseding ADR-0004;
   amendments on ADR-0011 and ADR-0015.
6. **Worker driver.** `tick`, cron, queue consumer, optional DO alarms, with
   Design E as the documented fallback.
7. **Cron source and the Runs view fields** of S14.

## 12. Decisions needed

1. Does the Inngest executor driver survive past phase 5, for hosts that cannot
   run a worker, at the cost of keeping ADR-0011? Recommendation: no.
2. Which `defineEvent` flow-control options do real adopters use? `throttle` and
   `rateLimit` ship only if the answer is yes.
3. Is the Cloudflare Worker backend a release target for the executor, or does it
   keep an Inngest or Cloudflare Workflows driver? Recommendation: tick-based
   driver, last.
4. Is cron a product feature now that the executor can schedule?
5. Is Design B (the cursor model) a destination to design towards from the start,
   which argues for `released_outlet` on the log row in phase 3, or a possibility
   kept open? Recommendation: add the column, defer the rewrite.
6. The host-facing API shape: `app.events.send` on the app value, a standalone
   `sendEvent` that takes the persistence handle, or both. The transactional
   outbox case (section 7.3) argues for exposing the inbox insert as a documented
   SQL contract as well.

## 13. Sources

Repository: `docs/adr/0004`, `0009`, `0011`, `0015`, `0019`; `AGENTS.md`;
`packages/core/src/backend/engine/{runtime,durable,scheduler,wait,wait-shared,core}.ts`;
`packages/core/src/backend/lib/inngest/{workflow-function,event-listener-function,runtime-events,client}.ts`;
`packages/core/src/backend/lib/effect/inngest-client.ts`;
`packages/core/src/backend/services/workflows/lifecycle/{cancel,wake-wait,signal-parked-waits}.ts`;
`packages/core/src/backend/lib/db/schema.ts`.

Libraries: DBOS (https://github.com/dbos-inc/dbos-transact-ts/,
https://docs.dbos.dev/typescript/reference/configuration,
https://docs.dbos.dev/explanations/concurrent-executions,
https://docs.dbos.dev/production/workflow-recovery,
https://docs.dbos.dev/typescript/tutorials/upgrading-workflows,
https://docs.dbos.dev/typescript/prompting.md,
https://github.com/dbos-inc/dbos-transact-ts/issues/1226);
Absurd (https://github.com/earendil-works/absurd,
https://github.com/earendil-works/absurd/blob/main/sql/absurd.sql,
https://lucumr.pocoo.org/2025/11/3/absurd-workflows/,
https://lucumr.pocoo.org/2026/4/4/absurd-in-production/);
Effect (https://effect.website/blog/releases/effect/40,
https://effect.website/blog/effect-v4-rc-september-recap,
https://effect.website/docs/v4/api/effect/workflow/WorkflowEngine,
https://effect.website/docs/v4/api/effect/workflow/DurableDeferred,
https://effect.website/docs/v4/api/effect/cluster/SingleRunner,
https://effect.website/docs/v4/api/effect/cluster/SqlMessageStorage);
Vercel Workflow (https://workflow-sdk.dev/worlds/postgres,
https://workflow-sdk.dev/docs/foundations/versioning);
pg-boss (https://pgboss.io/api/queues, https://pgboss.io/api/workers);
graphile-worker (https://worker.graphile.org/docs/error-handling,
https://worker.graphile.org/docs/pro/recovery, https://worker.graphile.org/docs/faq);
Hatchet (https://docs.hatchet.run/v1/architecture-and-guarantees,
https://docs.hatchet.run/v1/durable-event-waits,
https://hatchet.run/blog/postgres-survival-guide,
https://hatchet.run/blog/multi-tenant-queues);
Restate (https://docs.restate.dev/references/architecture,
https://github.com/restatedev/restate/blob/main/LICENSE);
Temporal (https://docs.temporal.io/workflow-definition,
https://docs.temporal.io/temporal-service/temporal-server,
https://docs.temporal.io/encyclopedia/detecting-activity-failures);
Inngest (https://www.inngest.com/docs/self-hosting,
https://www.inngest.com/docs-markdown/setup/connect,
https://github.com/inngest/inngest/blob/main/docs/SDK_SPEC.md,
https://www.inngest.com/docs/durable-execution/primitives/group-parallel,
https://github.com/inngest/inngest/blob/main/LICENSE.md);
Cloudflare (https://developers.cloudflare.com/workflows/reference/limits/,
https://developers.cloudflare.com/durable-objects/api/alarms/,
https://developers.cloudflare.com/queues/platform/limits/,
https://developers.cloudflare.com/workers/configuration/cron-triggers/,
https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/,
https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/,
https://blog.cloudflare.com/workflows-v2/).

Patterns: Postgres manual on `SELECT ... FOR UPDATE SKIP LOCKED`
(https://www.postgresql.org/docs/current/sql-select.html), `NOTIFY`
(https://www.postgresql.org/docs/current/sql-notify.html), advisory locks
(https://www.postgresql.org/docs/current/explicit-locking.html), client timeouts
(https://www.postgresql.org/docs/current/runtime-config-client.html);
https://www.recall.ai/blog/postgres-listen-notify-does-not-scale;
https://dbos.dev/blog/postgres-listen-notify-scalability;
https://planetscale.com/blog/keeping-a-postgres-queue-healthy;
https://kaleji.dev/posts/for-update-skip-locked-and-when-it-stops-working/;
https://brandur.org/job-drain; https://brandur.org/river;
https://riverqueue.com/docs/sqlite;
https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html;
https://oban.hexdocs.pm/ready_for_production.html;
https://microservices.io/patterns/data/transactional-outbox;
SQLite transactions and isolation (https://sqlite.org/lang_transaction.html,
https://www.sqlite.org/isolation.html, https://sqlite.org/wal.html);
Node `node:sqlite` (https://nodejs.org/api/sqlite.html).
