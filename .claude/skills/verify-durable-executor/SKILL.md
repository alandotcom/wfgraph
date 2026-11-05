---
name: verify-durable-executor
description: Model-check the Postgres executor proposed to replace Inngest (Design A in docs/internal/plans/separate-event-intake-from-durable-execution.md) with a TLA+ model run by tla-ts. Use when a change touches that design's claim, lease, pass, release, park resolution, cancellation or retry rules, when the executor it describes is being built, or when a change touches the existing guards the design reuses (claimWaitState, openResume's version fence, admitNode, finishRun). Triggers on "verify the executor", "model-check the design", "does the release still hold", or a claim that a run cannot be stranded, woken twice, or run after it ended.
---

# Verify the durable executor design

The design doc proposes an executor the library owns: a schedule row per
Execution that workers claim under a lease, a pass that replays the run against
a step memo, and producers that wake a Wait by writing its wait row. The timing
of those writes decides whether a run is ever stranded, woken twice, or run
after it ended, and no unit test explores every order they can land in. This
skill checks every order, up to the bounds below, with a TLA+ model and
`tla-ts`, a TLC-compatible model checker that runs on Node with no JVM.

Read this whole file before running anything.

## When a change needs this check

Run the check when a change touches any file or section in the coverage
record below. Run it on every edit to Design A's release, claim or
park-resolution rules, because each of those has already broken a rule once.

Find out whether the verification is stale before you trust it:

```sh
git log --oneline e3568e7c.. -- docs/internal/plans/separate-event-intake-from-durable-execution.md
git log --oneline a92cea15.. -- \
  packages/core/src/backend/services/executions/repo/waits.ts \
  packages/core/src/backend/services/executions/repo/runs.ts \
  packages/core/src/backend/engine/wait.ts \
  packages/core/src/backend/engine/scheduler.ts
```

A commit in either list means the model may no longer describe the design.
Read each of those commits against the coverage record before you rely on a
pass.

## Run it

```sh
.claude/skills/verify-durable-executor/check.sh
.claude/skills/verify-durable-executor/mutations.sh
```

`check.sh` checks each rule in its own `tla-ts` run, so a rule that breaks never
hides another. It prints the model's size, then `holds` or `breaks` for
`NoDeadlock` and for every rule. For a rule that breaks it prints the shortest
path to the break as numbered action names. It exits 0 when every rule holds, 1
when one breaks, and 2 when `tla-ts` cannot check the model. It takes about 3
seconds.

`mutations.sh` removes one guard of the design at a time and requires the rule
that guards it to break. It shows that a pass means something: a rule that has
never been seen to fail proves nothing. It takes under a minute.

Both scripts run `tla-ts@0.0.8` through `pnpm dlx`, so nothing is installed into
the workspace. Pass `SPEC=/path/to/Copy.tla` to `check.sh` to check a copy of the
model.

To read a result as a chart in plain words, use the pstack `/statechart` skill
on `model/DurableExecutor.tla` and `model/DurableExecutor.cfg`. It shows a
broken rule as its shortest path, and when every rule holds it draws how a run
moves between states. `/statechart` runs its own checker. `check.sh` is what
decides pass or fail.

## What the model is

One Execution of this graph, run by two workers:

```
Lifecycle --Started--> Wait A --+
          \            Wait B --+--> Join (an action that may fail)
           --Canceled--> Outlet (an action)
```

The two parallel Waits are the case ADR-0011 exists for. The Join behind both
is the case ADR-0011 leaves open. The Canceled outlet is where a Cancel Event
routes the run.

Every write a pass makes is one transaction that checks the lease first, as the
design's `run(step, fn)` does, so each pass action is one atomic step. The
lease holder is the fencing token (`owner_token`).

## Rules

| Rule | The promise | The harm when it breaks |
| --- | --- | --- |
| `WokenBranchIsNeverStranded` | A run never sleeps while one of its branches has been woken and not yet run. | The branch waits for another Wait's deadline, up to a year. |
| `SleepingRunHasADeadline` | A sleeping run always has an open Wait whose deadline will wake it. | The run sleeps until someone cancels it. |
| `EachWaitWokenOnce` | An Event, a timeout and a cancel never all win the same Wait. | A Wait resumes twice and its branch runs twice. |
| `EachBranchRunsOnce` | Each branch runs past its Wait at most once. | A message below the Wait is sent twice. |
| `JoinRunsOnceAfterBothBranches` | The Join runs at most once, and only after both branches ran. | The Join reads output that does not exist yet, or runs twice. |
| `OutletRunsOnceOnCancelClaim` | The Canceled outlet runs at most once, and only after a Cancel Event claimed the run. | Cancellation work runs twice or on a run nobody cancelled. |
| `NoStartedWorkAdmittedAfterClaim` | No Started-side work is admitted after a Cancel Event claims the run. | A canceled appointment still gets its reminder. |
| `NothingCommitsAfterTheRunEnds` | Nothing commits after the run has ended. | A canceled run keeps doing work. |
| `OneTerminalRecord` | The run's terminal record is written once. | The run's status flips after it ended. |
| `EndMatchesWork` | A completed run ran the Join, and a run canceled by a Cancel Event ran the outlet. | The Runs view reports work that never happened. |
| `FailedOnlyAfterRetriesSpent` | A run is marked failed only after its retries were spent on failures. | A transient error fails a run with no retry. |
| `LeaseHasAHolder` | A leased schedule row has a lease holder, and no other row does. | Two workers believe they own the run. |

## Bounds and assumptions

- Two workers, two Waits, `MaxAttempts = 2` (the design's `attempt < 4`, scaled
  down). The checked model has 23,718 distinct states.
- Counters stop one past `MaxAttempts`, because nothing compares them further.
- The `CountersBounded` constraint caps each observer counter at 2. That cap
  keeps a mutated model finite. In the model as written, every counter stays at
  most 1 whenever its rule holds, so the cap cuts only states where a rule has
  already broken.
- Each guarded write is atomic. That holds in the design because each is one
  SQL statement, or one transaction that locks the schedule row first. The park
  producer's `select ... for update` on the schedule row is what makes
  `EventWake` and `CancelEvent` one step against `Release`; without that lock the
  producer's conditional update can miss a release in flight.
- Clock time is abstract: a timeout is "the deadline passed", and lease length,
  heartbeat interval and backoff are not modelled.

## Coverage record

| Model part | Design doc section (Design A) | Existing code the design reuses |
| --- | --- | --- |
| `Claim`, `ClaimWhenDue` | "The invocation", step 1 | |
| `LeaseHeldBy`, `Fenced` | "The runtime", `run(step, fn)` | |
| `Visit`, `RunsPast`, `sawParked` | "A park is a value"; "The runtime", `waitForEvent` | `openResume` and `createWaitState` fences in `engine/wait.ts`, `startWait` in `repo/waits.ts` |
| `Admit`, `StartedSideAdmits` | "Cancellation" | `admitNode` and the `lifecycle-check` boundary in `engine/scheduler.ts` and `engine/cancel-boundary.ts` |
| `JoinSucceeds`, `JoinFails`, `NothingToRun` | "Retries" | |
| `Release`, `ReleaseReadsWaitRows`, `EndRun` | "The invocation", step 4 | `finishRun` in `repo/runs.ts`, which refuses a claimed run |
| `RunInFlight` | "Cancellation" | `finishRun` updates an in-flight row only |
| `LeaseExpires`, `Crash` | "Lease and liveness" | |
| `EventWake`, `WakeIsUnclaimed` | "Resolving a park" | `claimWaitState` in `repo/waits.ts` (`status = 'waiting'`) |
| `CancelEvent` | "Cancellation" | `requestCanceledOutlet` in `services/workflows/lifecycle/cancel.ts` |
| `PolicyCancel` | "Cancellation", the policy cancel | `cancelInFlightRuns` in `services/executions/end-runs.ts` |

Last confirmed against: the design doc at `e3568e7c`, and the existing code at
`a92cea15` (`main`). Move these two commits forward only after you have read
the covered sections and files at the new commit and confirmed the model still
describes them. When the executor is built, add its files to the last column
and replace the doc sections with the code that implements them.

## Telling a real bug from a modelling error

A broken rule is a claim about the design until you have checked the path
against the design. Walk the printed path one action at a time, and for each
action find the sentence in the design doc, or the line of code, that permits
it.

- Every step is permitted by the design: the bug is real. Report it as the
  path in the design's words. Do not weaken the rule or narrow the model to make
  it pass. Change the design only when the person who owns it asks.
- A step the design forbids, or a pair of writes the model treats as separate
  that the design makes one transaction: the model is wrong. Fix the model,
  then rerun both scripts.

Run `mutations.sh` after every model change. A `MISSED` line means the model no
longer exercises that guard, and a pass from it is worth nothing until it is
caught again. A `missing` line means the guard's text changed. Update the
mutation table to match.

## Changing the model for an intended design change

1. Edit the action that models the changed section, and keep each guard the
   design depends on as a named operator (`LeaseHeldBy`, `StartedSideAdmits`,
   `WakeIsUnclaimed`, `RunInFlight`, `ReleaseReadsWaitRows`). The mutations
   replace those names' definitions.
2. A new promise gets a new `INVARIANT` in `model/DurableExecutor.cfg`, stated
   as one sentence in the Rules table, and a row in `mutations.sh` that breaks
   it.
3. Run `check.sh` and `mutations.sh`. Every mutation must be caught, and every
   rule must hold except the known findings below.
4. Update the coverage record and move the sync commits.

## Known findings

`FailedOnlyAfterRetriesSpent` breaks on the design as written. The design's
claim counts an attempt every time it claims a queued row (`attempt = attempt +
(state = 'queued')`), and an Event wake re-queues the row. Waking a Wait
therefore spends a retry. The shortest path:

1. A worker claims the run (attempt 1), parks both Waits, and the run sleeps.
2. An Event wakes Wait A and re-queues the run.
3. A worker claims it again (attempt 2) while an Event wakes Wait B.
4. The pass runs both branches, admits the Join, and the Join's step throws a
   retriable error.
5. The release sees `attempt` at the limit and marks the run failed. The Join
   never got a retry.

Counting an attempt on a failed pass and on an expired lease, rather than on
every claim, makes every rule hold (18,236 states). The design doc now counts
attempts that way, in its claim and release steps, and names this finding.

## Not covered

- The Exit claim and Entity Eligibility, which resolve sibling parks like the
  Cancel Event does.
- Migration of a parked run (ADR-0019) and the version fences.
- More than one Execution, so Concurrency and supersede are absent.
- The event inbox and delivery fan-out (section 7 of the design doc), and
  handler sub-steps inside one node.
- A Wait on the Canceled side.
- Liveness. The model checks that nothing bad happens, never that a run
  eventually ends.
- The SQLite and Cloudflare Worker drivers, `LISTEN`/`NOTIFY` wake latency, and
  database failover.
