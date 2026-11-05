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
3. **An event inbox the executor drains.** A host on Inngest keeps raising
   Events with `inngest.send`. The Inngest source registers one listener
   function per catalog Event, and each forwards its Event into the inbox, so
   that host needs to know nothing about the inbox or the executor. A host with
   no Inngest raises an Event with `app.events.send`, over an HTTP route, or by
   inserting into the inbox table inside its own database transaction. The
   existing webhook intake writes to the inbox too. Delivery fan-out runs as a
   durable body on the same executor as workflow runs. Section 7.
4. **One port, several drivers.** The executor is reached through one Effect
   service. The Postgres and SQLite drivers run an in-process worker loop. The
   Cloudflare Worker driver exposes a bounded `tick` the platform's Cron
   Trigger, a Queue consumer, and optional per-run Durable Object alarms call.
   Section 8.

The order of work is in section 11. The first deliverable is the executor core,
built in production locations so it graduates: the park-as-value change, a
replay harness that takes a runtime, and the Postgres and SQLite drivers, held
to the engine's replay suites and the timing cases ADR-0011 records.
Everything after it depends on what it shows.

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
(`rateLimit`, `throttle`, `debounce`, `priority`, `timeouts`, `retries`) can be
declared on `defineEvent` and is handed to Inngest's `createFunction`; no Event
declares any of it, and section 7.4 drops it. The `inngest` option on
`createWfGraphApp` is required, and the Layer graph takes the client at
construction.

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
-- already round-trips. Written in its own transaction after the step body,
-- fenced on owner_token ("Fencing store writes").
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
   <new>, lease_expires_at = now() + <lease>`. The claim leaves `attempt` alone:
   a queued row is claimed after a wake as well as after a failure, and a count
   taken on every claim would spend a retry on each Event that woke a Wait. The
   TLA+ model in `.claude/skills/verify-durable-executor` found that path, with a
   Join whose step failed once after two wakes and was never retried. Only a
   step that throws and a lease that expires while a step runs count a failure,
   and each counts against that step ("Retries").
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
   `wake_at = now() + backoff` when a step body threw a retriable error and that
   step's own failure count, incremented, is at most four.
   When the retries are spent, the step fails its node and the run goes on, as
   "Retries" describes.

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

**Fencing store writes.** The memo row is not the only write a stale worker
can make. A step body's store writes go through `WorkflowStore`, which
`createDbWorkflowStore` fills, and each commits in its own transaction. Their
guards test the run's status, its pinned version, its Cancel or Exit claim, and
the wait row's status. None tests which worker is writing. A worker whose lease
expired in the middle of a step could therefore:

- flip a running run to waiting (`createWaitState`,
  `markExecutionWaitingIfParked`), or a parked run to running
  (`markExecutionRunning`);
- cancel the live worker's open log and wait rows (`cancelOpenWork`);
- take an Exit claim the live worker did not decide (`requestExit`);
- write the run's terminal record before the live worker does (`finishRun`).

So every store write the executor makes carries the pass's `owner_token`, and
the repository checks it against the schedule row inside the write's own
transaction: `FOR SHARE` on Postgres, and the `BEGIN IMMEDIATE` write on SQLite.
A mismatch refuses the write and stops the pass, the same as a refused memo
write. The check takes the schedule row before the execution and wait rows,
the order the producer and the release use. `createDbWorkflowStore` binds the
token once per pass, so the engine's `WorkflowStore` port does not change.

The fence leaves one window open: a store write that commits just before its
memo row is refused. The next pass finds no memo and runs the step again.
Today's Inngest memo has the same window. The store writes a re-run step
repeats are therefore idempotent:

- `startStepLog` inserts a row whose id derives from the execution id and the
  node id, with `on conflict do nothing`. A node opens its log row in one step
  per Execution, and its retries reuse that row.
- `completeStepLog` updates only a row that is still `running` or was closed as
  `error`. A re-run of the same close writes the same values, and a retry that
  succeeds after an attempt failed can still correct the row's verdict.

The terminal write deletes the schedule row, which leaves the pass that wrote
it with no row to fence against. That pass makes its remaining store writes,
such as the run's closing timeline entry, without the fence, and writes no
more memo rows. No other pass can reach that state: every other pass's fence
names the schedule row that no longer exists, so its writes are refused.

The other store writes are already conditional updates, except
`recordAuditEvent`, which stays a plain insert. A derived id there would have
to come from the entry's content, which would merge two legitimate identical
timeline entries, such as one Wait re-parking after a Migration. A duplicate
timeline row in the crash window is the smaller harm, and Inngest leaves the
same one today. The Handler model in
`.claude/skills/verify-durable-executor` checks both halves. Without the fence,
a stale worker rewrites a node's outcome after it ended, or fails a node the
live worker would retry. With the fence but a random log row id, one lease
expiry between the insert and its memo row leaves the node with two log rows.

**Resolving a park.** Every producer that sends a `workflow/wait.signal` today
instead writes the wake onto the wait row and re-queues the execution, in one
transaction:

```sql
select state from workflow_execution_schedule
 where execution_id = $executionId for update;            -- taken first, whatever the state holds
update workflow_wait_states
   set wake = $wake, status = 'resuming'
 where id = $waitStateId and status = 'waiting';          -- conditional: one wake per park
update workflow_execution_schedule
   set state = 'queued', wake_at = now()
 where execution_id = $executionId and state = 'waiting';  -- a leased run is re-queued by its release
```

The unconditional lock on the first line is load-bearing. A conditional update
alone takes no row lock when its predicate fails on a `leased` row, so a release
reading the wait rows in the same window would miss the wake and write
`waiting`. Locking the row first serialises the producer against the release
below: the producer either commits before the release reads, or waits for the
release to commit and then finds `waiting`.

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
release writes `queued` with a backoff and one more failure on that step's memo
row, which holds the step's failure count until the step succeeds and its
value replaces it; the memo keeps every step that completed. Failures are
counted per step. A count kept for the whole run would hand each later step the
retries its predecessors spent: a step that failed three times before it
succeeded would leave the next step one retry. The TLA+ Handler model checks
this with two steps that can each fail. A `StepFailure` keeps travelling as a value
(ADR-0009) so a refused vendor call fails the node once. A non-retriable failure
of the run itself, such as an execution row that no longer exists, writes the
terminal record through the store and deletes the schedule row.

When a step's count would pass four, the step fails its node and the run
carries on. The release writes the failure into the step's memo row as its
result, the way a `StepFailure` is stored, so every later pass reads the node as
failed. A step that runs outside any node, such as the run's terminal record,
has no node to fail: when its retries are spent, the run ends `failed` through
the fenced terminal write. The branch below the failed node halts. Every
other branch keeps running, and so does a Canceled outlet the run has entered.
The run's terminal status is chosen when nothing is left to run, the way
`executeWorkflow` chooses it today: `canceled` when a Cancel claim stands and
its outlet has run, `exited` for an Exit claim, `failed` when a node failed, and
`completed` otherwise. Ending the run `failed` as soon as a step's retries ran
out would abandon a Canceled outlet already in progress: the model check in
`.claude/skills/verify-durable-executor` found a Join admitted before a Cancel
Event that failed on its last retry after the outlet's Wait had parked, so the
outlet's work never ran. Today a run whose step keeps failing is marked failed
by Inngest and its execution row reads `running` forever, so either behaviour is
new.

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
`markExecutionRunning` keep working unchanged. A refused fence ends the pass,
and the next pass reloads the newer graph, which is the behaviour ADR-0019
describes. The engine reports a refused fence as a failure kind of its own, and
the release re-queues the run with `wake_at = now()` and the attempt counter
unchanged. A refused fence is the run having moved, so nothing failed: counting
it as an attempt would let a Migration that lands during a pass mark the run
failed with no step having failed, which the model check in
`.claude/skills/verify-durable-executor` found. `WAIT_ATTEMPT_LIMIT` still caps
how many times one Wait is prepared again, so a run migrated over and over still
stops.

**Exit claim.** The run that wins `requestExit` resolves its own sibling parks
as `{ kind: "exit" }` inside the same step. With one run per Execution the
siblings are branches of the same invocation; their parks resolve on the next
pass and halt, which is what `wakeParkedWaits` achieves across invocations today.

**Lease and liveness.** Lease sixty seconds, heartbeat every twenty from the
worker while a step body runs, renewed on every memo write. The heartbeat
records which step is running on the schedule row. An expired lease is swept
inside the claim statement, bounded to the batch size, and the swept row is
re-queued with a failure counted against the step that was running, the way
Absurd's `claim_task` fails the run with `$ClaimTimeout`. A lease that expires
between steps counts against the run's own counter on the schedule row, which
ends the run `failed` past the same limit and resets on every release. The lease is shorter than any platform kill timeout
(section 8), and the fencing token makes a lease that expired under a worker that
was merely slow a harmless duplicate attempt rather than a duplicate side effect.

**Wake latency.** Postgres: `LISTEN` on one channel, and a one-second poll as the
backstop. The notify is an optimisation only; timers always need the poll. A
transaction that issued `NOTIFY` takes a global exclusive lock at commit and holds
it through the fsync, so those commits run one at a time and lose group commit;
the recall.ai and DBOS write-ups both measured the ceiling this sets. The re-queue
write therefore commits with no `NOTIFY`. Each process buffers the execution ids it
re-queued and flushes one `NOTIFY` in its own transaction every 50 ms, so re-queue
commits keep group commit and only the flush takes the lock. A crash loses at most
one buffer of notifications, which the poll recovers. SQLite: an in-process ticker
at two hundred and fifty milliseconds. Worker: section 8.

**Retention.** Inngest stores the step memo and the in-flight event queue on its
own infrastructure and expires them under its own policy. This executor moves
that storage into the adopter's database, so the library decides how long each
row lives.

- The schedule row holds the working set by construction: the terminal write
  deletes it. Its cost is update churn from claims, lease renewals and releases,
  which the table settings in section 8 address.
- The memo rows of an execution are deleted in the transaction that writes its
  terminal record, the same transaction that deletes the schedule row. A run
  that has written its terminal record is never claimed, replayed or migrated
  again, so nothing reads its memo afterwards. The Runs view reads log rows and
  never the memo. The memo table then holds the working set too: about two
  hundred and fifty rows for each open run of a fifty-node graph, and no rows
  for finished runs. A policy cancel deletes the memo with the schedule row. A
  leased pass of that run has its memo in memory already, and its next fenced
  write is refused.
- A delivery's memo rows are deleted in the transaction that sets the inbox
  row's `delivered_at`, for the same reason.

The inbox (section 7.1) and the run history tables have retention questions of
their own, which section 12 lists.

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

Same as Design A, with the executor behind one Effect service. The service is
kept: phase 2 introduces it with the database driver as its one implementation.
Keeping an Inngest adapter as a second implementation, for the transition or
for hosts that cannot run a worker, is the part that was rejected. The port:

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

This is `InngestClient` with its five sends renamed by intent. The database
driver maps them to the row writes of section 6.1. An Inngest driver would have
mapped `resolvePark` to `sendWaitSignal` and `stopRun` to the two cancel sends,
and kept ADR-0011's branch machinery alive, because Inngest's wake policy has
not changed. The migration is built on one branch that merges once (section
11), so no Inngest driver is built: the reliability suite compares the executor
with the same suite run on `main` (section 12, decision 1).

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

**Inbox retention.** The inbox gains one row for every arrival, and nothing in
the delivery path deletes one. A sweep deletes delivered rows whose
`received_at` is older than a retention window. The window is also the
deduplication window: the unique `(name, idempotency_key)` index refuses a
resent key only while the first row exists. Once a sweep deletes the row, the
same key is accepted as a new arrival with a new inbox id, so the
`(workflow_id, delivery_id)` index on `workflow_executions` does not catch it
either, and new runs start. Inngest has the same property today: an event `id`
deduplicates for 24 hours, and after that the same id triggers functions again.
The window length is a decision (section 12). Undelivered rows are never swept.

Whether `workflow_executions.delivery_id` becomes a foreign key to the inbox
decides how the sweep works. As a foreign key, the sweep has to keep every inbox
row an execution still names, which keeps the inbox as large as the run history.
As a plain text column, as it is today against the Inngest event id, the sweep
is free to delete, and an old execution's `delivery_id` names a row that no
longer exists. The recommendation is the plain column.

### 7.2 Delivery is a durable body on the executor

`runEventListener` already takes a `step` port with one verb, `run`, and fans
out through memoized steps named `subscribers-*`, `lifecycle-*`,
`wait-candidates-*` and `waits-*`. It becomes the second kind of body the
executor runs: a schedule row with `kind = 'delivery'` and the inbox id, claimed
and leased the same way, with the same memo table keyed by the inbox id. One
queue, one lease, one memo, two bodies. The schedule table's foreign key
points at `workflow_executions`, so a delivery's schedule row, keyed by an
inbox id, cannot share it as written; phase 3 gives deliveries a nullable
execution id with a separate inbox key, or a schedule table of their own. A delivery retries under the executor's
own attempt limit, the same one a run uses (section 7.4).

### 7.3 Sources

A source is anything that inserts an inbox row and enqueues its delivery.

- **The Inngest source, the default path for a host on Inngest.** An entry
  (`@wfgraph/core/inngest`, or a package) that builds one Inngest function per
  catalog Event whose body is one `send`. The host publishes with
  `inngest.send`, as `docs/events.md` documents today, keeps its Inngest-side
  idempotency, and needs no knowledge of the inbox or the executor. Its one
  wiring step is mounting the entry's functions on its Inngest `serve`. Workflow
  Graph's own durability starts at the inbox row. The `inngest` peer dependency
  moves to that entry, so only a host that uses Inngest installs it.
- **`app.events.send({ name, data, id? })`** on `WfGraphApp`, for a host with
  no Inngest. Validated against the catalog at the boundary. `docs/events.md`
  documents it beside `inngest.send`.
- **`POST {basePath}/api/events`** on the machine routes, authenticated by a
  shared signing key the way the Inngest callback is today, for a host with no
  Inngest whose producer is a different process or language.
- **A host's own transaction.** A host that shares the database can insert the
  inbox row inside the transaction that produced the business fact, which is the
  transactional outbox the host cannot get from any external bus. The executor
  picks it up on its poll. This is worth documenting as a first-class pattern;
  it is the strongest argument for the inbox over any external bus.
- **Webhook intake** (exists). `receiveWebhook` calls `send` instead of
  `sendCatalogEvent`; the Connection id becomes a column instead of a stamped
  payload key, which removes `catalog-connection.ts`.
- **Cron.** There is no scheduled start today. With the executor owning a
  scheduler, a `workflow_schedules` table with `next_fire_at` and a
  compare-and-swap enqueue (`update ... where last_enqueued_at is not distinct
  from $seen returning`, then insert the inbox row with idempotency key
  `name:fire_time`) adds it at low cost. It is a product decision whether to.

### 7.4 Per-Event flow control

Dropped. `defineEvent` lets an Event Author declare Inngest's `rateLimit`,
`throttle`, `debounce`, `priority`, `timeouts` and `retries` through its `inngest`
option (`extensions/inngest-options.ts`). No Event uses it. The built-in
integrations and the example app declare none of these options, and neither do
the fourteen Events in Fountain's `spike/donor-os-workflows` branch at
`14d21cae9`. Re-homing them would have meant a token bucket per key for
`throttle` and `rateLimit` and a held, re-pointed delivery row for `debounce`,
which is the hardest part of the intake to get right under many workers.

When the inbox lands, `defineEvent` loses its `inngest` option and
`extensions/inngest-options.ts` is deleted, under the no-backwards-compatibility
convention in AGENTS.md. A delivery retries under the executor's own attempt
limit, the same one a run uses. An Event that later needs its own retry count or
priority gets it as a plain field on the Event definition.

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
deleted with the schedule row ("Retention" in section 6.1), so neither table
grows with run history.

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
between loading the version and parking fails the fence and ends the pass
without counting an attempt, and the next pass loads the newer graph, the
behaviour ADR-0019 describes.

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
  and they already model abandonment at every undiscovered step. Each suite
  calls `driveWithReplay` directly and six of them assert ADR-0011's branch
  runs, so phase 1 first makes the harness take a runtime, re-run a parked body
  and wake a run on any resolution. The cases that enter a Wait in place then
  run unchanged on both drivers, and each branch-run case gains a single-run
  equivalent beside it. The branch-run cases keep covering the Inngest path
  until phase 2 deletes it.
- **Memo write amplification.** Five writes per node is fine at the scale this
  product runs at; it is the number to watch. The Design B cursor model is the
  answer if it becomes the bottleneck.
- **The Worker driver.** The least certain piece and the easiest to defer.
- **One long branch.** The migration merges into `main` once, so `main` moves
  under it for weeks. The branch is rebased onto `main` often, and the
  reliability suite compares the branch's outcomes with `main`'s.
- **Storage moves to the adopter.** The memo, the queue and the event inbox
  live in the adopter's database instead of Inngest's. The memo and schedule
  rows are deleted at the terminal write, so their size follows the number of
  open runs. The inbox and the run history tables grow with traffic until the
  retention decisions in section 12 are made and their sweeps are built.
- **Public contract.** `createWfGraphApp`'s required `inngest` option becomes
  optional and then goes; `docs/events.md`, both published skills, the example
  app and the peer dependency change. One major version under the fixed group.

## 11. Recommended path

The whole migration is built on one feature branch, `feat/durable-executor`,
cut from `main` with this document, and merged into `main` once when the last
phase is done. Each commit on the branch passes the AGENTS.md check list, so
the branch is green at every step. No intermediate state ships, so no phase
keeps compatibility machinery alive for the next one.

1. **The executor core.** Six units, committed in order:
   - E1. A Wait's park is a value in the engine (section 6.2).
   - E2. `driveWithReplay` takes a runtime, re-runs a parked body and wakes a
     run on any resolution. Each case that enters a Wait in place runs in both
     modes, and each ADR-0011 branch-run case gains a single-run equivalent
     beside it.
   - E3. The schedule and memo tables, the wait-row columns and
     `released_outlet` on the log row, in both schemas; the claim, release,
     producer and memo writes as `ExecutionRepo` methods; and the fenced,
     idempotent store writes of "Fencing store writes".
   - E4. A Postgres driver for `WorkflowExecutionRuntime` runs the replay
     suites.
   - E5. A SQLite driver runs the same suites, started only after E4 passes.
   - E6. A worker loop, and the wake timings measured by wall clock on both
     backends.

   Exit criteria: every case in the eight suites that enters a Wait in place
   passes unchanged on both drivers; each single-run equivalent passes; S2, a
   Cancel while both Waits are parked, and a Wait behind a Wait pass under the
   harness's virtual clock and once by wall clock with scaled durations, within
   a second of their targets, on both backends; and
   `.claude/skills/verify-durable-executor/check.sh` passes. If a replay case
   fails for a reason the park-as-value change cannot fix, the work stops and
   reports before any more driver code is written.

2. **Runs move to the executor.** `ExecutionDriver` (section 6.4) replaces
   `InngestClient` in `WfGraphServices`, with the database driver as its one
   implementation. The producers become the row writes of section 6.1:
   `wakeWait`, `signalParkedWaits`, `migrateExecutions`, the Cancel claim's
   outlet request, `signalRunToStop` and `enqueueStartedRun`.
   `createWfGraphApp` runs the worker loop. The `workflow-run` and
   `workflow-branch` Inngest functions are deleted with everything under
   ADR-0011, including the branch-run tests. The reliability suite runs on the
   executor, and each family's outcomes are compared with the same suite on
   `main`. New ADR superseding ADR-0004; amendments on ADR-0011 and ADR-0015.
   Event delivery stays on Inngest until phase 3. Phase 1 left four items for
   this phase, because no producer reaches them before it:
   - Every producer wakes the worker loop after its write: through the loop's
     in-process wake in its own process, and on PostgreSQL through the
     buffered `NOTIFY` of "Wake latency" for loops in other processes. The
     poll alone finds a producer's wake up to one poll interval late, which
     put a Cancel on PostgreSQL past the one-second bound in phase 1's
     timings.
   - The Migration producer takes the schedule row's lock before the execution
     row, re-queues the run, and lets `repinVersion` move a run that is
     running or holds a woken Wait.
   - The engine's wait-row read includes the `wake` column, so an Event wake
     written onto a row whose version has since moved is not lost.
   - A pass that finds its run no longer in flight deletes the run's schedule
     and memo rows.
3. **The inbox.** `workflow_event_inbox`, delivery bodies on the executor, the
   Inngest source entry, `app.events.send`, the HTTP route, webhook intake
   rewired. `defineEvent` loses its `inngest` option and
   `extensions/inngest-options.ts` is deleted (section 7.4).
4. **Inngest leaves the core.** The Inngest source entry is the only Inngest
   code left; `inngest` leaves `createWfGraphApp` and the core's peer
   dependencies; `scripts/dev.ts` drops the CLI; `docs/events.md`, both
   published skills and the example app change; one major-version changeset.
5. **Worker driver.** `tick`, cron, queue consumer, optional DO alarms, with
   Design E as the documented fallback.
6. **Cron source and the Runs view fields** of S14.

## 12. Decisions

1. Decided: no Inngest executor driver. Keeping one for hosts that cannot run
   a worker would keep ADR-0011's branch runs, kill event and sweep. Phase 1
   adds a single-run equivalent beside each ADR-0011 branch-run test, and phase
   2 deletes the branch-run tests when runs move to the executor.
2. Decided: per-Event flow control is dropped, because no Event in this
   repository or in Fountain's spike declares any of it (section 7.4).
3. Decided: the Cloudflare Worker backend is a release target for the executor,
   through the tick-based driver of section 8, built last (phase 5). Design E
   stays the fallback.
4. Decided: cron waits for phase 6. The executor makes it cheap to add then.
5. Decided: `released_outlet` is added to the log row in phase 1's schema, and
   the Design B rewrite is deferred.
6. Decided: both `app.events.send` and the inbox insert as a documented SQL
   contract, for a host with no Inngest. The SQL contract is what lets a host
   raise an Event inside its own transaction (section 7.3). A host on Inngest is
   unaffected, since it keeps `inngest.send` through the Inngest source.
7. How long a delivered inbox row is kept, which is also how long a resent
   idempotency key is refused (section 7.1). Inngest's equivalent window is 24
   hours. Recommendation: a configurable window on `createWfGraphApp`
   defaulting to seven days, so that a host retrying a send over a weekend
   still deduplicates.
8. Whether the library prunes run history. `workflow_executions`,
   `workflow_execution_logs`, `workflow_execution_events` and closed
   `workflow_wait_states` rows grow with every run today, and nothing deletes
   them. That growth exists with or without this executor, and the data lives
   in the adopter's database. Recommendation: a retention option on
   `createWfGraphApp` that deletes terminal executions older than a window,
   with their rows in the child tables, and that is off by default. Time
   partitioning waits until volume calls for it.

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
https://www.inngest.com/docs/durable-execution/guides-and-advanced/idempotency,
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
