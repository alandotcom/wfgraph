# Executor phase 1 plan

Phase 1 of `docs/internal/plans/separate-event-intake-from-durable-execution.md` builds the executor core in production locations. A Wait's park becomes a value, the replay harness takes a runtime, and a Postgres and a SQLite driver run the engine's replay suites with no Inngest. Adopters see nothing yet, because nothing in `createWfGraphApp` reaches the drivers until phase 3. The next engineer inherits a driver that the TLA+ models in `.claude/skills/verify-durable-executor` already describe. The rule the program enforces is that every executor write is fenced on the lease's owner token and every write a re-run step repeats is idempotent. The PRs in order are E1, E2, E3, E4, E5 and E6.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `pstack/skills/poteto-mode/playbooks/autopilot-stack.md`. The operator lands every PR. E1 and E2 change no production behaviour and may land on `main` as soon as they are verified. E3 to E6 stop at merge-ready on the stack until phase 2 lands, because nothing in the app reaches them before then.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] Read these from trunk at program start. Re-read them at every tick.
  - [ ] `git show origin/main:AGENTS.md`
  - [ ] `git show origin/main:docs/internal/plans/separate-event-intake-from-durable-execution.md`, sections 6.1, 6.2, 10 and 11
  - [ ] `git show origin/main:.claude/skills/verify-durable-executor/SKILL.md`
  - [ ] `git show origin/main:.claude/skills/live-run/SKILL.md`
  - [ ] The local pstack plugin's `skills/poteto-mode/playbooks/autopilot-stack.md`, `skills/swarm/SKILL.md` and `skills/poteto-mode/playbooks/opening-a-pr.md`, because pstack is a plugin and lives outside this repository
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names, each in its own worktree reset to its base branch head.
- [ ] Follow this dependency graph. Base dependent work on the parent branch, since the execution playbook stacks.
  - [ ] E1 and E3 are independent and first. Both branch from `main`.
  - [ ] E2 after E1.
  - [ ] E4 after E2 and E3. It branches from E3 with E2 merged in.
  - [ ] E5 after E4. The SQLite driver starts only once E4 meets its criteria.
  - [ ] E6 after E5.
- [ ] Hold the file boundaries. E1 and E2 touch only `packages/core/src/backend/engine/**`. E3 touches only `packages/core/src/backend/lib/db/schema.ts`, `packages/core/drizzle/**`, `packages/core/src/backend/persistence/**` and `packages/core/src/backend/services/executions/repo/**`. E4 to E6 own `packages/core/src/backend/executor/**` and touch `packages/core/src/backend/engine/db-store.ts` only to bind the fence.
- [ ] Hold the review gate. No PR changes an interaction, so none waits for a video review.
- [ ] Stop the program and report if a replay case fails on a driver for a reason the park-as-value change in E1 cannot fix. No more driver code is written until the operator answers.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, per **Opening a PR**. Use `gh pr create --base <base-branch>`. A stack child targets its parent branch.
- [ ] Run `pnpm run type-check`, `pnpm run lint` and `pnpm run knip` once before the PR-facing push. Push with hooks on.
- [ ] Run `/deslop` before each commit and `/no-comments` before review.
- [ ] Triage every Bugbot and security-reviewer comment per `../references/bugbot-triage.md`.
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, on a CI failure that comes from a change on trunk, or when a known concurrent change to the same files lands.
- [ ] Run `.claude/skills/verify-durable-executor/check.sh` and `mutations.sh` on every PR that changes a behaviour a model names, and update the model in the same PR when the design moved.

### Verdict and merge, for every PR

- [ ] A full swarm runs once, at the code-ready head. Another full swarm runs only for new behavior, a redesign, or a large new diff. A rebase, a merge-conflict resolution, or a minor fix gets a single verifier at the new head, and a wording-only change gets none. Run each full swarm per the local plugin's `skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Judge every finding by the execution playbook's blocking rule. The verdict is clean when none blocks. A failure on trunk behavior in a lane marked `Regression lane against trunk.` is recorded against trunk and does not block the PR. A new head gets a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends each verified PR to the stack and reports it merge-ready. The operator lands the stack bottom-up. A rebase that keeps the patch-id keeps the verdict.

### Boot recipe, for every live lane

Each live lane runs in its own git worktree at the PR head, the Claude Code stand-in for a cloud VM. There is no `control-cli` skill in this environment, so a lane drives the command line through Bash.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] Run `pnpm install`, then `docker compose up -d`. Create a database of the lane's own named `wfgraph_lane_<n>` and point `WFGRAPH_TEST_DATABASE_URL` at it, because the test projects sweep `wfgraph_test_` schemas and lanes sharing one database would drop each other's.
- [ ] Deliver input only through `pnpm exec vitest run <file>`, `pnpm run test:postgres`, `pnpm run test:reliability`, the probe scripts this plan names, and the `live-run` skill. Read state only with `psql` and `sqlite3` queries.
- [ ] Save every log to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.log` and return the paths with the report.

## Let a Wait's park be a value in the engine (E1)

**Depends on.** None.

**Files.**

- [ ] Edit `packages/core/src/backend/engine/runtime.ts`.
- [ ] Edit `packages/core/src/backend/engine/wait-shared.ts`.
- [ ] Edit `packages/core/src/backend/engine/wait.ts`.
- [ ] Edit `packages/core/src/backend/engine/scheduler.ts`.
- [ ] Edit `packages/core/src/backend/engine/core.ts`.
- [ ] Create `packages/core/src/backend/engine/core-park.test.ts`.

**Build.**

- [ ] `WorkflowExecutionRuntime.waitForEvent` may answer `{ parked: true }`, a JSON-safe value, and `readWaitWake` reads it as a `parked` wake.
- [ ] On a `parked` wake the Wait driver returns a `WaitOutcome` that halts the branch and leaves the node's result unrecorded.
- [ ] `executeWorkflow` runs every other branch as far as it can and returns a parked result naming how many parks are open, writing no terminal record.

**You see.**

- [ ] A run over the in-memory runtime answering `{ parked: true }` returns a parked result with two open parks for a graph with two sibling Waits, and the recording store holds no terminal record.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `core-park.test.ts` covers one parked Wait, two sibling parked Waits, a parked Wait beside a branch that completes, and a parked Wait behind a Condition. Run `pnpm exec vitest run packages/core/src/backend/engine/core-park.test.ts`.
- [ ] The eight replay suites pass unchanged. Run `pnpm exec vitest run packages/core/src/backend/engine`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-opus-5-5-high` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Drive two sibling Waits of 20 and 90 seconds against `inngest dev` with the `live-run` skill at trunk and head. Save `s2-inngest.log`. Pass when head's short branch acts within one second of trunk's and both runs complete.
- [ ] Lane 2. Drive a Cancel Event while both Waits are parked with `live-run`. Save `cancel-parked.log`. Pass when the Execution ends `canceled` and both wait rows read `cancelled`.
- [ ] Lane 3. Drive a Wait behind a Wait with `live-run`. Save `wait-behind-wait.log`. Pass when both node rows close in order and the run completes.
- [ ] Lane 4. Run `pnpm run test:reliability` with `WFGRAPH_RELIABILITY_BACKEND=sqlite`. Save `reliability-sqlite.log`. Pass when every family passes.
- [ ] Lane 5. Run `pnpm run test:reliability` with `WFGRAPH_RELIABILITY_BACKEND=postgres`. Save `reliability-postgres.log`. Pass when every family passes.
- [ ] Lane 6. Run the eight replay suites ten times in a loop. Save `replay-repeat.log`. Pass when every iteration passes.
- [ ] Lane 7. Run `core-park.test.ts` with a graph of 50 nodes and ten Waits generated by a script. Save `park-wide.log`. Pass when the parked count is ten and no node below a Wait has a log row.
- [ ] Lane 8. Drive a Migration of a parked run with `live-run`. Save `migrate-parked.log`. Pass when the run resumes on the new version as ADR-0019 describes.
- [ ] Lane 9. Drive an Exit claim while a sibling Wait is parked with `live-run`. Save `exit-parked.log`. Pass when the Execution ends `exited` and the sibling wait row closes.
- [ ] Lane 10. Run `pnpm run type-check`, `pnpm run lint`, `pnpm run test` and `pnpm run knip`. Save `gates.log`. Pass when each exits 0 and lint prints nothing.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Median wall time of `executeWorkflow` over the in-memory runtime for a 50-node graph with no Waits, at trunk and head.
- [ ] Probe. A script runs the graph 30 times at trunk, then 30 at head, interleaved in five rounds.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Head fails if its median exceeds trunk's by more than 10 percent.

**Review gate.** None. E1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends E1 to the stack, and the operator lands it on `main`.

## Let the replay harness take a runtime and wake on any resolution (E2)

**Depends on.** E1.

**Files.**

- [ ] Edit `packages/core/src/backend/engine/testing/replay-runtime.ts`.
- [ ] Edit `packages/core/src/backend/engine/testing/replay-runtime.test.ts`.
- [ ] Edit `packages/core/src/backend/engine/core-parallel-wait.test.ts`, `core-cancel.test.ts`, `core-cancel-partial-progress.test.ts`, `core-migration-snapshot.test.ts`, `core-wait-split.test.ts`, `core-wait-migrate.test.ts` and `entity-eligibility.test.ts`.

**Build.**

- [ ] `driveWithReplay` takes a runtime factory, so a database driver can stand in for its in-memory runs.
- [ ] A second mode answers `{ parked: true }` for an unresolved park, re-runs a body that returned parked, and wakes a run on any resolution.
- [ ] Each case that enters a Wait in place runs in both modes.
- [ ] Each ADR-0011 branch-run case gains a single-run equivalent beside it. That covers sibling Waits of 20 and 90 seconds, a Cancel while both are parked, a Wait behind a Wait, a killed branch's partial progress, and inherited outputs after a Migration.

**You see.**

- [ ] In the new mode, the sibling-Wait case reports one run, the short branch acting at 20000 virtual milliseconds and the long one at 90000.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `replay-runtime.test.ts` gains cases for the new mode's re-run and any-resolution wake. Run `pnpm exec vitest run packages/core/src/backend/engine`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-opus-5-5-high` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the eight suites at trunk and head. Save `suites-trunk-head.log`. Pass when every case that passed at trunk passes at head in the existing mode.
- [ ] Lane 2. Run the sibling-Wait single-run case. Save `s2-single.log`. Pass when the run count is 1 and the actions land at 20000 and 90000.
- [ ] Lane 3. Run the Cancel-while-parked single-run case. Save `cancel-single.log`. Pass when the Canceled outlet runs once and the terminal status is `canceled`.
- [ ] Lane 4. Run the Wait-behind-a-Wait single-run case. Save `wait-wait-single.log`. Pass when the second Wait parks only after the first resumes.
- [ ] Lane 5. Run the Migration single-run cases. Save `migrate-single.log`. Pass when the outputs above the Wait match the branch-run case's.
- [ ] Lane 6. Count the in-place cases in each mode with `vitest --reporter=json`. Save `case-counts.log`. Pass when both modes run the same cases.
- [ ] Lane 7. Mutate the new mode to wake only at the last pause and rerun lane 2. Save `policy-mutation.log`. Pass when lane 2's case fails.
- [ ] Lane 8. Mutate the new mode to drop the re-run of a parked body and rerun lane 4. Save `rerun-mutation.log`. Pass when lane 4's case fails.
- [ ] Lane 9. Run the suites ten times in a loop. Save `repeat.log`. Pass when every iteration passes.
- [ ] Lane 10. Run `pnpm run type-check`, `pnpm run lint`, `pnpm run test` and `pnpm run knip`. Save `gates.log`. Pass when each exits 0 and lint prints nothing.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time of `pnpm exec vitest run packages/core/src/backend/engine` at trunk and head.
- [ ] Probe. Run it five times at trunk and five at head, interleaved.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Head fails if its median exceeds trunk's by more than 50 percent, since head runs the in-place cases twice.

**Review gate.** None. E2 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends E2 to the stack, and the operator lands it on `main`.

## Add the schedule, memo and fenced writes to both schemas (E3)

**Depends on.** None.

**Files.**

- [ ] Edit `packages/core/src/backend/lib/db/schema.ts`.
- [ ] Create the migration `pnpm run db:generate` writes under `packages/core/drizzle/`.
- [ ] Edit `packages/core/src/backend/persistence/sqlite/schema.ts`, and regenerate with `pnpm run db:generate:sqlite`.
- [ ] Edit `packages/core/src/backend/persistence/sqlite/migrations.ts` for `EXPECTED_TABLES` and the schema fingerprints.
- [ ] Create `packages/core/src/backend/services/executions/repo/schedule.ts` and its SQLite twin under `packages/core/src/backend/persistence/sqlite/executions/`.
- [ ] Edit `packages/core/src/backend/services/executions/repo/node-logs.ts`, `audit.ts`, `runs.ts` and `waits.ts`.
- [ ] Create `packages/core/src/backend/persistence/conformance/execution-schedule.ts` and register it.
- [ ] Edit `packages/core/src/backend/persistence/postgres-concurrency.pg.test.ts`.

**Build.**

- [ ] The `workflow_execution_schedule` and `workflow_execution_steps` tables, the `park_step_id` and `wake` columns on `workflow_wait_states`, and `released_outlet` on the log row, in both schemas.
- [ ] `ExecutionRepo` gains `claimDue`, `releasePass`, `resolvePark`, `readMemo` and `writeMemo`. The claim uses `FOR UPDATE SKIP LOCKED` on Postgres and `UPDATE ... RETURNING` under `BEGIN IMMEDIATE` on SQLite. `resolvePark` and `releasePass` each lock the schedule row first, then read or write the wait rows, in one transaction.
- [ ] Every engine store write accepts an owner fence and checks it against the schedule row inside its own transaction, taking the schedule row before the execution and wait rows.
- [ ] `openNodeLog` and the audit insert take ids derived from the execution and step id with `on conflict do nothing`, and `closeNodeLog` updates only a `running` row.
- [ ] The terminal write deletes the schedule row and the memo rows in its own transaction.

**You see.**

- [ ] The conformance file passes on both backends, and a fenced write with a stale token is refused with a typed failure.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `execution-schedule.ts` covers claim order, lease expiry, release outcomes, a refused fence, idempotent log writes and the terminal delete. Run `pnpm run test` and `pnpm run test:postgres`.
- [ ] `postgres-concurrency.pg.test.ts` gains a producer racing a release on two connections, and two claimers on one due row. Run `pnpm run test:postgres`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-opus-5-5-high` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `pnpm run test:postgres` and `pnpm run test` at trunk and head. Save `suites.log`. Pass when every case that passed at trunk passes at head.
- [ ] Lane 2. Migrate a database created at trunk and holding runs to head with `pnpm run db:migrate`. Save `pg-upgrade.log`. Pass when the migration applies and the old rows read back unchanged.
- [ ] Lane 3. Open a SQLite file created at trunk with head's backend. Save `sqlite-upgrade.log`. Pass when the file migrates on open and its runs list unchanged.
- [ ] Lane 4. Run `pnpm run db:generate` and `pnpm run db:generate:sqlite` at head. Save `generate-clean.log`. Pass when neither writes a change.
- [ ] Lane 5. Race 200 producer and release pairs on two connections with a probe script. Save `race.log`. Pass when no run ends `waiting` while a wait row holds an unconsumed wake.
- [ ] Lane 6. Run four claimers against 1000 due rows. Save `claimers.log`. Pass when each row is claimed exactly once.
- [ ] Lane 7. Expire a lease and claim the row again with a probe script. Save `expiry.log`. Pass when the attempt counter grows by one and the old token's writes are refused.
- [ ] Lane 8. Write a log open twice for one step id. Save `log-idempotent.log`. Pass when one row exists.
- [ ] Lane 9. Write a terminal record for a run with memo rows. Save `terminal-delete.log`. Pass when the schedule and memo rows are gone and the log rows remain.
- [ ] Lane 10. Run `pnpm run type-check`, `pnpm run lint`, `pnpm run knip` and `pnpm run build`. Save `gates.log`. Pass when each exits 0 and lint prints nothing.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Trunk has no claim, so this PR sets absolute budgets. The added work is the claim statement and a fenced store write on Postgres with 10000 schedule rows. The state a user waits for is a claimed run.
- [ ] Probe. A script times 1000 claims and 1000 fenced log writes at head, interleaved with 1000 unfenced log writes at trunk.
- [ ] Baseline. Record the trunk unfenced log write median first.
- [ ] Rule. Head fails if a claim's median exceeds 5 milliseconds or a fenced log write's median exceeds trunk's unfenced write by more than 2 milliseconds.

**Review gate.** None. E3 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends E3 to the stack. It stays merge-ready until phase 2 lands, and then the operator lands it.

## Run the replay suites on a Postgres driver (E4)

**Depends on.** E2 and E3.

**Files.**

- [ ] Create `packages/core/src/backend/executor/runtime.ts`, the database `WorkflowExecutionRuntime`.
- [ ] Create `packages/core/src/backend/executor/pass.ts`, one pass from claim to release.
- [ ] Edit `packages/core/src/backend/engine/db-store.ts` to bind the owner fence per pass.
- [ ] Create `packages/core/src/backend/executor/replay-suites.pg.test.ts`.

**Build.**

- [ ] `run(step, fn)` answers from the memo, or runs `fn` and writes the memo row fenced on the owner token.
- [ ] `waitForEvent` answers the wake on the wait row, or records `park_step_id` and answers `{ parked: true }`. The deadline comes from `wait_until` on the row.
- [ ] A pass claims, loads the memo in one query, runs `executeWorkflow`, and releases by the outcome. A refused fence re-queues with the attempt unchanged, and a spent step fails its node while the run goes on.

**You see.**

- [ ] `replay-suites.pg.test.ts` runs every in-place case and every single-run equivalent through the Postgres driver, with the harness's virtual clock.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `pnpm run test:postgres` with `WFGRAPH_REQUIRE_POSTGRES=1`.
- [ ] Run `.claude/skills/verify-durable-executor/check.sh` and `mutations.sh`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-opus-5-5-high` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk has no database driver, so this lane records that. Run the in-place cases at trunk under `driveWithReplay` and at head under the Postgres driver. Save `driver-vs-harness.log`. Pass when every case passes on both and the node outputs match.
- [ ] Lane 2. Reproduce the first model finding, a wake landing during a pass on a Wait the pass read as parked. Save `wake-during-pass.log`. Pass when the run is re-queued and the woken branch runs.
- [ ] Lane 3. Fail a Join on its last retry after a Cancel outlet's Wait parked. Save `retries-spent-outlet.log`. Pass when the outlet runs and the run ends `canceled`.
- [ ] Lane 4. Migrate a run during a pass. Save `migrate-during-pass.log`. Pass when the attempt counter is unchanged and the next pass runs the new version.
- [ ] Lane 5. Pause a worker mid-step past its lease while a second worker completes the run. Save `stale-worker.log`. Pass when the stale worker's store writes are refused and the run's status and log rows match the live worker's.
- [ ] Lane 6. Kill a worker between a log insert and its memo row. Save `crash-window.log`. Pass when the node has one log row after the replay.
- [ ] Lane 7. Count memo rows for a 50-node graph run. Save `memo-rows.log`. Pass when there are at most five per node and none after the terminal write.
- [ ] Lane 8. Exit a run while a sibling Wait is parked. Save `exit.log`. Pass when the sibling park resolves as `exit` on the next pass and the run ends `exited`.
- [ ] Lane 9. Run `check.sh` and `mutations.sh`. Save `models.log`. Pass when both exit 0.
- [ ] Lane 10. Run `pnpm run type-check`, `pnpm run lint`, `pnpm run test`, `pnpm run test:postgres` and `pnpm run knip`. Save `gates.log`. Pass when each exits 0 and lint prints nothing.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Trunk runs a pass on Inngest, so this PR sets absolute budgets. The added work is one replay pass of a 50-node graph whose nodes are all memoized. The state a user waits for is the pass after a wake.
- [ ] Probe. A script times 100 such passes on Postgres at head, interleaved with 100 `executeWorkflow` calls over the in-memory runtime at trunk.
- [ ] Baseline. Record the trunk in-memory median first.
- [ ] Rule. Head fails if its pass median exceeds the trunk median by more than 50 milliseconds.

**Review gate.** None. E4 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends E4 to the stack. It stays merge-ready until phase 2 lands, and then the operator lands it.

## Run the replay suites on a SQLite driver (E5)

**Depends on.** E4.

**Files.**

- [ ] Create `packages/core/src/backend/executor/replay-suites.sqlite.test.ts`.
- [ ] Edit `packages/core/src/backend/executor/runtime.ts` and `pass.ts` only where SQLite's single writer differs.

**Build.**

- [ ] The same driver over the SQLite repositories. A claim holds `BEGIN IMMEDIATE` for the row flip alone, and no step body runs inside a write.

**You see.**

- [ ] `replay-suites.sqlite.test.ts` runs the same cases as E4 through the SQLite driver.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `pnpm run test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-opus-5-5-high` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk has no database driver, so this lane records that. Run the in-place cases at trunk under `driveWithReplay` and at head under the SQLite driver. Save `driver-vs-harness.log`. Pass when every case passes on both and the node outputs match.
- [ ] Lane 2. Run E4 lane 2 on SQLite. Save `wake-during-pass.log`. Pass when the run is re-queued and the woken branch runs.
- [ ] Lane 3. Run E4 lane 3 on SQLite. Save `retries-spent-outlet.log`. Pass when the outlet runs and the run ends `canceled`.
- [ ] Lane 4. Run E4 lane 4 on SQLite. Save `migrate-during-pass.log`. Pass when the attempt counter is unchanged.
- [ ] Lane 5. Run E4 lane 6 on SQLite. Save `crash-window.log`. Pass when the node has one log row.
- [ ] Lane 6. Hold a step body for two seconds while an HTTP read of the Runs view runs against the same file. Save `writer-held.log`. Pass when the read answers within 100 milliseconds.
- [ ] Lane 7. Compare each case's node outputs between the E4 and E5 drivers. Save `pg-vs-sqlite.log`. Pass when they match.
- [ ] Lane 8. Run the example app against a SQLite file the drivers wrote. Save `example-app.log`. Pass when the Runs view lists the runs with their log rows.
- [ ] Lane 9. Run the SQLite suite ten times in a loop. Save `repeat.log`. Pass when every iteration passes.
- [ ] Lane 10. Run `pnpm run type-check`, `pnpm run lint`, `pnpm run test` and `pnpm run knip`. Save `gates.log`. Pass when each exits 0 and lint prints nothing.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Trunk has no SQLite driver, so this PR sets absolute budgets. The added work is one claim and one memoized 50-node pass on SQLite. The state a user waits for is the pass after a wake.
- [ ] Probe. A script times 100 claims and 100 passes at head, interleaved with 100 in-memory `executeWorkflow` calls at trunk.
- [ ] Baseline. Record the trunk in-memory median first.
- [ ] Rule. Head fails if a claim's median exceeds 2 milliseconds or a pass median exceeds the trunk median by more than 50 milliseconds.

**Review gate.** None. E5 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends E5 to the stack. It stays merge-ready until phase 2 lands, and then the operator lands it.

## Measure the wake timings by wall clock on both backends (E6)

**Depends on.** E5.

**Files.**

- [ ] Create `packages/core/src/backend/executor/worker-loop.ts`, a poll loop that phase 3 extends.
- [ ] Create `scripts/executor-timing.ts`.

**Build.**

- [ ] A worker loop that polls every second on Postgres and ticks every 250 milliseconds on SQLite, and runs one pass per claimed row.
- [ ] A timing script that runs sibling Waits of 2 and 9 seconds, a Cancel while both are parked, and a Wait behind a Wait on each backend, and prints each node's action time against its target.

**You see.**

- [ ] The script prints the short branch's action within one second of 2 seconds and the long branch's within one second of 9 seconds, on both backends.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `worker-loop.test.ts` covers a stop signal and a pass that throws. Run `pnpm run test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-opus-5-5-high` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Measure sibling Waits of 20 and 90 seconds on `inngest dev` at trunk with `live-run`, and at head with the timing script on Postgres. Save `s2-trunk-vs-head.log`. Pass when head's two actions land within one second of 20 and 90 seconds.
- [ ] Lane 2. Run the 2 and 9 second case on SQLite. Save `s2-sqlite.log`. Pass when both actions land within one second of target.
- [ ] Lane 3. Run the Cancel case on Postgres. Save `cancel-pg.log`. Pass when the run ends `canceled` within one second of the Cancel Event.
- [ ] Lane 4. Run the Cancel case on SQLite. Save `cancel-sqlite.log`. Pass when the run ends `canceled` within one second of the Cancel Event.
- [ ] Lane 5. Run the Wait-behind-a-Wait case on Postgres. Save `wait-wait-pg.log`. Pass when each Wait resumes within one second of its target.
- [ ] Lane 6. Run the Wait-behind-a-Wait case on SQLite. Save `wait-wait-sqlite.log`. Pass when each Wait resumes within one second of its target.
- [ ] Lane 7. Run two worker loops on Postgres and kill one mid-pass. Save `failover.log`. Pass when the run completes within one lease plus one poll of the kill.
- [ ] Lane 8. Run 100 sibling-Wait runs at once on Postgres. Save `load.log`. Pass when the 95th percentile lateness is under one second.
- [ ] Lane 9. Run 100 sibling-Wait runs at once on SQLite. Save `load-sqlite.log`. Pass when the 95th percentile lateness is under one second.
- [ ] Lane 10. Run `pnpm run type-check`, `pnpm run lint`, `pnpm run test`, `pnpm run test:postgres` and `pnpm run knip`. Save `gates.log`. Pass when each exits 0 and lint prints nothing.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Lateness of each Wait's resume against its target, on trunk's Inngest run and on head's executor run.
- [ ] Probe. Run lane 1's 20 and 90 second case three times at trunk and three at head, interleaved.
- [ ] Baseline. Record trunk's lateness first. ADR-0011 records 0.1 seconds for the short branch and 1 second for the run's end.
- [ ] Rule. Head fails if any resume is more than one second late.

**Review gate.** None. E6 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends E6 to the stack. It stays merge-ready until phase 2 lands, and then the operator lands it.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Move the code sync point in `.claude/skills/verify-durable-executor/SKILL.md` to the last landed commit, and add the executor files to its coverage table.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

Four questions were settled before this plan, on branch `plan/separate-event-intake-from-durable-execution`.

- Whether the eight replay suites can run unchanged on a new driver. They cannot, because each calls `driveWithReplay` directly, six assert ADR-0011 branch runs, and the harness treats a body that returns as finished (`engine/testing/replay-runtime.ts` lines 473 to 476). The exit criteria were rewritten at `15f944e7` and `fb097220`.
- Whether a stale worker's store writes need the owner-token fence. They do. A catalogue of every `WorkflowStore` write found that no guard tests which worker writes, and the Handler model shows both halves of the fix. Without the fence a stale worker rewrites a node's outcome, and with the fence but a random log row id one lease expiry leaves two log rows. Decided at `9f79c206`, modelled at `395426f7`.
- Whether the repositories can share a transaction across aggregates. They cannot, because `Database.query` hands every call the root connection. The memo row therefore takes its own fenced transaction, and the producer and the release are single `ExecutionRepo` methods.
- How the ADR-0011 timings were measured. By hand against `inngest dev`, so E6 measures them again by wall clock on both backends.

Unproven until E4 and E5 run is whether every in-place case passes on a database driver with no engine change beyond E1.

## Appendix B. Alternatives rejected

- A scratch-branch spike thrown away after it reports. Rejected because the target architecture is decided and a spike in production locations graduates into phase 3.
- Rewriting the ADR-0011 branch-run tests in phase 1. Rejected because the Inngest driver runs branch runs in production until phase 5.
- Writing the memo row in the same transaction as the step's store write. Rejected because it needs a transaction handle threaded through every repository method. A fenced memo transaction with idempotent store writes gives the same guarantee, and the Handler model checks it.
- A general unit of work in the persistence layer. Rejected for the same reason, since the producer and the release each fit one repository method.

## Appendix C. Risks

- E1 changes the Wait driver's halt path, which the Inngest driver also runs. Lanes 1 to 5 of E1 drive the Inngest path at head against trunk.
- `pnpm run knip` may report the executor as unused until phase 3 wires it. If it does, E3 to E6 stay on the stack until phase 2 lands, which the plan already assumes.
- The SQLite single writer blocks the event loop during a claim. E5 lane 6 measures that a read is not held behind a step body.
- No `control-cli` skill exists in this environment, so live lanes drive the command line through Bash and save logs instead of screenshots.
- Lanes share one Postgres server. The boot recipe gives each lane its own database.

## Appendix D. Links and reading list

- `docs/internal/plans/separate-event-intake-from-durable-execution.md`, sections 6.1, 6.2, 9, 10 and 11.
- `.claude/skills/verify-durable-executor/SKILL.md`, for the rules each PR must keep holding.
- `docs/adr/0011-a-waiting-branch-is-a-durable-run-of-its-own.md` and `docs/adr/0019`, for the behaviours the single-run cases replace.
- The `how` skill runs before E1 over the Wait driver and the scheduler's halt path, and before E4 over `createDbWorkflowStore`. The `interrogate` skill runs on E3's fence design before E4 starts.
- The decision trail per the `show-me-your-work` skill starts at program start, beside this plan, as `executor-phase-1.trail.md`.
