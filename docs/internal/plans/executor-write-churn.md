# Executor write churn on PostgreSQL

Status: proposed, 2026-11-08. Two changes, each its own commit series: a lease index
that lets a lease renewal be a HOT update, and a node log row that serves as its own
memo.

## What was measured

`examples/measure-bloat.ts` on branch `measure/schedule-bloat` drives 3,000 runs at
30 per second through `events.send` against the compose PostgreSQL 17, with the
runner's defaults. Each run is four action steps, a 2 s delay Wait and two more
steps, so it takes two passes. The harness samples `pg_stat_user_tables` every 5 s.

| Table                         | Per run                          | HOT | Peak dead tuples                 |
| ----------------------------- | -------------------------------- | --- | -------------------------------- |
| `workflow_execution_schedule` | 33 updates, 2 inserts, 2 deletes | 0%  | 57,846 beside about 50 live rows |
| `workflow_execution_steps`    | 29 inserts, 29 deletes           | n/a | 52,083                           |

Autovacuum ran once a minute on both tables. Neither table can be vacuumed sooner
by a per-table setting: each is past its trigger threshold within seconds, so the
server-wide `autovacuum_naptime` decides, and that setting belongs to the host.

The 33 schedule updates are two per pass for the claim and the release, and one per
memo row, because `writeStepMemo` extends `lease_expires_at` in the transaction that
writes the memo. `workflow_execution_schedule_lease_idx` indexes `lease_expires_at`,
so none of those updates can be HOT.

Of the 29 memo rows, one per action node is the handler's own step. Two per node are
`node:<id>:log-open` and `node:<id>:log-close:<status>`, which memoize the node log
writes; the entry node has those two, and the Wait has four steps of its own.

## Change 1: index leased rows by id

Replace `workflow_execution_schedule_lease_idx`, on `lease_expires_at` where
`state = 'leased'`, with `workflow_execution_schedule_leased_idx` on `id` where
`state = 'leased'`.

The claim's expired-lease arm (`expiredLease` in `repo/release-policy.ts`) still has
an index: it reads every leased row and filters on `lease_expires_at`, and leased
rows number at most the total concurrency of the running loops. A renewal, from
`renewLease` or `writeStepMemo`, changes `lease_expires_at`, `running_step_id` and
`running_node_id`, none of which any index then covers, so PostgreSQL can apply it as
a HOT update. A claim and a release change `state`, which the partial indexes'
predicates read, and stay non-HOT.

Measured as DDL on the harness schema, one run each:

| Variant                          | HOT updates      | Peak dead tuples | Peak heap | Peak indexes |
| -------------------------------- | ---------------- | ---------------- | --------- | ------------ |
| Baseline                         | 0 of 99,000      | 57,846           | 1,800 KB  | 2,552 KB     |
| Leased index, fillfactor 70      | 86,983 of 99,000 | 10,961           | 1,320 KB  | 1,472 KB     |
| Leased index, default fillfactor | 86,791 of 99,000 | 11,230           | 416 KB    | 1,352 KB     |

The default fillfactor gives the same HOT rate with a smaller heap, since the
schedule's own deletes leave room on each page. Drizzle 1.0.0-rc.5 declares no table
storage parameters either, so the change is the index alone.

Work:

1. Edit the index in `packages/core/src/backend/lib/db/schema.ts`, with a comment
   saying why its key is `id`.
2. `pnpm run db:generate` against the compose database.
3. Check with `EXPLAIN` on a seeded table that `claimDue` uses the new index for the
   expired-lease arm.
4. SQLite keeps its own schema and has no HOT, so it is left as it is.
5. `pnpm run test:postgres` and the harness again.

## Change 2: the node log row is its own memo

### The design

The node log open and close stop running through `runtime.run`, so neither writes a
memo row. Both writes are idempotent:

- The open inserts under `nodeLogId(executionId, nodeId)` with `ON CONFLICT DO
  NOTHING` (`openNodeLogWrite` in `repo/node-logs.ts`), backed by
  `workflow_execution_logs_execution_node_uidx`, so a second open answers the first
  row.
- Every close, fenced or not, carries its guard in `WHERE` (`nodeLogCloseGuard` in
  `repo/node-log-close.ts`): it applies when `status = 'running'`, or when
  `status = 'error'` and the close reports `success`. A later success corrects an
  error, a second error leaves the first, and a success is never overwritten. A
  close the guard refuses writes no row version.

`WorkflowStore.startStepLog` and `completeStepLog` (`engine/store.ts`) state those
two guarantees, which are what make it safe for the engine to open and close a
node's row on every pass that reaches it.

**The open is an idempotent runtime step.** `WorkflowExecutionRuntime`
(`engine/runtime.ts`) has a third method beside `run` and `waitForEvent`,
`runIdempotent`, which runs `fn` on every pass and stores no value. A failure counts
against the step's id and stops the pass as a failure inside `run` does, so
`step_failed`, its backoff and `STEP_RETRY_LIMIT` apply to a failed open, and a step
whose retries are spent is refused before `fn` runs. Action nodes open through it
under `node:<id>:log-open` (`runWithStepLog` in `engine/step-log.ts`), and so does
the Wait (`engine/wait.ts`), which used to memoize its open only to keep the
handle's `startTime`.

The database executor's implementation (`executor/runtime.ts`) adds two rules:

- A success over a `failing` memo row writes the row `succeeded` through the
  existing memo write, which keeps the failure count for the node log's `retries`
  and clears the schedule row's running step in the same transaction. Without it, a
  finished node kept reading as retrying for the rest of the run, and failures
  added to its count on later passes until it was refused. This write happens only
  on that recovery path.
- An idempotent step is never the step the heartbeat records as running. A lease
  expiry or a budget cut during a millisecond log write counts as the run's own
  failure, as a failure between steps does, rather than against a log step that may
  already have finished.

**The close is a direct store write.** `runWithStepLog` closes the row through
`closeStepLogQuietly`, which swallows a failure. The close counts no
failure, so it has no reason to be a step, and a refusal of a step can neither fail
a node that did its work nor replace the work's own failure. The close is fenced
like every store write of the pass, so a close after the pass stopped or lost its
lease is refused by the store with `LeaseLost`. That refusal follows every step that
throws, once for each node the pass was running, so it logs nothing; any other
refusal logs one warning naming the run and the node.

**The pass reads the run's log rows when it opens.** `runBody.open`
(`executor/run-body.ts`) reads each row's id, status and `started_at` through
`listNodeLogStates`, beside the run input and before any step runs, so a failed
read fails the pass rather than a step. It hands the rows to
`createDbWorkflowStore` (`engine/db-store.ts`) as data. The store skips an open
for a node with a row, answering that row's `started_at` as the handle's
`startTime`, which is how a Wait's close on a later pass measures the whole park.
It skips a close `nodeLogCloseApplies` refuses, and keeps the map current with its
own writes. The map is a hint for skipping writes; the SQL guard is the authority,
and a close for a row the map does not hold falls through to the write. One read
per pass replaces two fenced transactions per replayed node.

### What it saves

Per action node: memo rows 3 to 1, schedule updates 3 to 1, fenced transactions
5 to 3. Per Wait, one memo row and one schedule update fewer.

Measured on the branch with the harness, 3,000 runs:

| Measure                                 | Before | After  |
| --------------------------------------- | ------ | ------ |
| Memo rows per run                       | 29     | 15     |
| Schedule updates per run                | 33     | 19     |
| Schedule updates applied as HOT         | 0%     | 79%    |
| `workflow_execution_schedule` peak dead | 57,846 | 10,279 |
| `workflow_execution_steps` peak dead    | 52,083 | 25,212 |

The measurement predates the Wait's open moving off its memoized step, so the Wait's
open memo row and the schedule update its memo write made are still in the "After"
column; each run of the harness passes one Wait.

### What changes in behaviour

- A failed log open counts on its own step id, and a later success marks that step
  `succeeded`, so the node stops reading as retrying.
- `running_step_id` never names a log step.
- A failed close never fails a node and never hides the work's failure.
- A second `error` close keeps the first error's message and duration, on every
  close path.

### The model

`.claude/skills/verify-durable-executor/model/Handler.tla` models the open as an
idempotent step whose insert can throw a retriable error counted against its own
step, the recovery write (`SuccessReconcilesFailures`), a heartbeat that records the
holder's running step and never the open (`IdempotentStepIsNeverRunning`), an
expired or swept lease that counts against the step the schedule row names, and the
read at claim (`PassReadsLogRows`). The rule `FinishedNodeNeverRefused` says a node
whose log row is closed as a success is never failed or refused afterwards and none
of its steps reads as retrying. Mutations `success-leaves-failures` and
`log-open-is-running-step` each break it. With `PassReadsLogRows` off, a pass runs
the insert of an open that already succeeded again, and a failure there is counted
by nobody, so `NodeEnds` breaks (mutation `pass-reads-no-log-rows`).

### Work

1. `runIdempotent` on the runtime port, the database executor's runtime and the test
   runtimes, with the recovery write and no running step.
2. The `WHERE` guard on every close, PostgreSQL and SQLite, in
   `repo/node-log-close.ts`, with conformance cases for each of the six close
   transitions.
3. The pass-open read, `listNodeLogStates` on both backends, and the store over the
   rows it is handed.
4. `runWithStepLog` and the Wait on `runIdempotent`, and the close as a quiet store
   write.
5. The model, `mutations.sh` and `SKILL.md`; `check.sh` and `mutations.sh` pass.
6. The harness again, reporting memo rows and schedule updates per run.
