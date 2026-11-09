# Executor write churn on PostgreSQL

Status: proposed, 2026-11-08. Two changes, each its own commit series: a lease index
that lets a lease renewal be a HOT update, and a node log row that serves as its own
memo.

## What was measured

`examples/measure-bloat.ts` on branch `measure/schedule-bloat` drives 3,000 runs at
30 per second through `events.send` against the compose PostgreSQL 17, with the
runner's defaults. Each run is four action steps, a 2 s delay Wait and two more
steps, so it takes two passes. The harness samples `pg_stat_user_tables` every 5 s.

| Table | Per run | HOT | Peak dead tuples |
|---|---|---|---|
| `workflow_execution_schedule` | 33 updates, 2 inserts, 2 deletes | 0% | 57,846 beside about 50 live rows |
| `workflow_execution_steps` | 29 inserts, 29 deletes | n/a | 52,083 |

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

| Variant | HOT updates | Peak dead tuples | Peak heap | Peak indexes |
|---|---|---|---|---|
| Baseline | 0 of 99,000 | 57,846 | 1,800 KB | 2,552 KB |
| Leased index, fillfactor 70 | 86,983 of 99,000 | 10,961 | 1,320 KB | 1,472 KB |
| Leased index, default fillfactor | 86,791 of 99,000 | 11,230 | 416 KB | 1,352 KB |

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

`runWithStepLog` (`engine/step-log.ts`) stops running the open and the close through
`runtime.run`. The writes are already idempotent:

- The open inserts under `nodeLogId(executionId, nodeId)` with `ON CONFLICT DO
  NOTHING` (`openNodeLogWrite` in `repo/node-logs.ts`), backed by
  `workflow_execution_logs_execution_node_uidx`. The memoized handle's `logId` is
  that same id, and its `startTime` is read by nobody on this path, since each
  attempt times its own work.
- The fenced close changes a row only while it is `running` or `error`
  (`nodeLogCloseSet` in `repo/release-policy.ts`). It does that with a `CASE` inside
  `SET`, so a close that changes nothing still writes a row version. The guard moves
  into `WHERE`: the fenced close applies when `status = 'running'`, or when
  `status = 'error'` and the close reports `success`. That is the rule the per-verdict
  memo ids implement today: a later success corrects an error, a second error leaves
  the first, and a success is never overwritten. The unfenced close is unchanged.

Two pieces keep the existing retry and replay behaviour.

**A runtime method for idempotent writes.** A store write outside a durable step that
fails becomes an `EngineFailure` of kind `failure`, which `endsPass` does not end the
pass on, so the node would fail on a transient database error. `WorkflowExecutionRuntime`
(`engine/runtime.ts`) gains a third method beside `run` and `waitForEvent`:

```ts
/**
 * Runs `fn` on every pass, which is safe only because `fn` is idempotent. It
 * stores nothing when `fn` succeeds. A failure counts against `step.id` and
 * stops the pass exactly as a failure inside `run` does, and a step whose
 * retries are spent is refused before `fn` is called.
 */
runIdempotent: <T>(step: DurableStepRef, fn: () => Promise<T>) => Promise<T>;
```

The database executor's implementation (`executor/runtime.ts`) shares `stepMemoBook`'s
answer for a `failed` row and its failure counting, and skips `remember`. A step that
failed and later succeeded keeps its `failing` row until the run ends, which the node
log's `retries` column already reads. The test runtimes implement it by calling `fn`.

**A pass-start read of the run's log rows.** A pass loads the memo in one query
(`loadMemo` in `executor/pass.ts`), so a replayed log step costs no query today.
Without a read, every pass would re-issue an open and a close for every node it
replays. The store `engine/db-store.ts` builds for a pass reads the run's log rows
once, on its first log write, into a map of node id to status, and updates the map
with its own writes. `startStepLog` skips the insert for a node with a row.
`completeStepLog` skips a close the `WHERE` guard would refuse. One query per pass
replaces one fenced transaction per replayed log step. The map is exact for the
pass: only the lease holder writes log rows, and the pass holds the lease.

The Wait is unchanged. Its open sits inside its own memoized step
(`wait-start-log-<node>`), whose `startTime` measures the park, and its closes are
already direct store writes guarded by the conditional close.

### What it saves

Per action node: memo rows 3 to 1, schedule updates 3 to 1, fenced transactions 5 to
3. For the measured workflow: memo rows 29 to 15 per run, schedule updates 33 to
about 19.

### What changes in behaviour

- A failed log write is counted on its step id as today, so `step_failed`, its
  backoff and `STEP_RETRY_LIMIT` apply unchanged.
- `running_step_id` names a log step while its write runs, as today, and the Runs view
  reads it the same way.
- A node whose log row is open when its handler step fails, and whose retries are
  spent, closes as `error` exactly as now.

### The model

`.claude/skills/verify-durable-executor/model/Handler.tla` checks this already, with
two edits: `Claim` reads the log row (`seenOpen` is "the row exists", `seenClose` is
"the row is closed"), and `OpenMemo` and `CloseMemo` write no memo. Run on a copy on
2026-11-08, every `Handler` rule held and every `REACH` state was reached, about
15,900 states.

With the read in place, the two existing mutations `log-id-random` and
`log-close-unconditional` no longer break their rules, because a fenced pass that
reads the row never opens or closes it twice. Each guard still carries its rule when
the read is absent: with no read and no memo, the guards alone held both rules, and
removing either one broke its rule. So the model gets a `PassReadsLogRows` switch,
and those two mutations flip it off together with their guard. `mutations.sh` takes
one replacement per line, so the switch and the guard share one constant per
mutation, or the script learns to take two.

The `Handler` section of the skill's `SKILL.md` and its code-mapping row change with
it: the log steps are idempotent writes, and the pass reads the log rows.

### Work

1. `runIdempotent` on the runtime port, the database executor's runtime and the test
   runtimes, with executor tests for a failing idempotent step: counted, backed off,
   refused once spent.
2. The `WHERE` guard on the fenced close, PostgreSQL and SQLite (`sqlite/logs.ts`),
   with conformance cases for each of the three close transitions.
3. The pass-start read in `engine/db-store.ts`, with a repository read on both
   backends and a conformance case.
4. `runWithStepLog` on `runIdempotent`; engine and replay tests updated for the step
   ids that no longer appear in the memo.
5. The model, `mutations.sh` and `SKILL.md`; `check.sh` and `mutations.sh` pass.
6. The harness again, reporting memo rows and schedule updates per run.
