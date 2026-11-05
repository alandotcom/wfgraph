---
name: verify-durable-executor
description: Model-check the Postgres executor proposed to replace Inngest (Design A and the event inbox in docs/internal/plans/separate-event-intake-from-durable-execution.md) with TLA+ models run by tla-ts. Use when a change touches that design's claim, lease, pass, release, park resolution, cancellation, Exit claim, retries, Migration, inbox, delivery or Concurrency rules, when the executor it describes is being built, or when a change touches the existing code the design reuses (claimWaitState, openResume's version fence, admitNode, finishRun, startForEntity, repinVersion, answerFromCommittedDecision). Triggers on "verify the executor", "model-check the design", "does the release still hold", or a claim that a run cannot be stranded, woken twice, opened twice, or run after it ended.
---

# Verify the durable executor design

The design doc proposes an executor the library owns: a schedule row per
Execution that workers claim under a lease, a pass that replays the run against
a step memo, producers that wake a Wait by writing its wait row, and an inbox
whose deliveries run on the same executor. The order in which those writes land
decides whether a run is stranded, woken twice, opened twice, or run after it
ended. No unit test explores every order. This skill checks every order, up to
stated bounds, with three TLA+ models and `tla-ts`, a TLC-compatible model
checker that runs on Node with no JVM.

Read this whole file before running anything.

## When a change needs this check

Run the check when a change touches any design section or file in the coverage
record. Run it on every edit to the release, claim, park-resolution, retry or
Concurrency rules, because each of those has broken a rule at least once.

Find out whether the verification is stale before you trust it:

```sh
git diff --stat -- docs/internal/plans/separate-event-intake-from-durable-execution.md
git log --oneline afc0ce3c.. -- docs/internal/plans/separate-event-intake-from-durable-execution.md
git log --oneline a92cea15.. -- \
  packages/core/src/backend/services/executions/repo/waits.ts \
  packages/core/src/backend/services/executions/repo/runs.ts \
  packages/core/src/backend/services/executions/repo/index.ts \
  packages/core/src/backend/services/executions/end-runs.ts \
  packages/core/src/backend/services/workflows/lifecycle/cancel.ts \
  packages/core/src/backend/services/workflows/lifecycle/concurrency.ts \
  packages/core/src/backend/services/workflows/lifecycle/deliver-event.ts \
  packages/core/src/backend/services/workflows/migration/migrate.ts \
  packages/core/src/backend/engine/wait.ts \
  packages/core/src/backend/engine/scheduler.ts \
  packages/core/src/backend/engine/cancel-boundary.ts
```

The first command shows an edit you have not committed yet. Output from the
other two means the models may no longer describe the design. Read each listed
commit against the coverage record before you rely on a pass.

## Run it

```sh
.claude/skills/verify-durable-executor/check.sh             # every model
.claude/skills/verify-durable-executor/check.sh Migration   # one model
.claude/skills/verify-durable-executor/mutations.sh
```

`check.sh` checks each rule in its own `tla-ts` run, so a rule that breaks never
hides another. For each model it prints the state count, then one line per
check:

- `holds` or `breaks` for `NoDeadlock` and for every rule. A rule that breaks is
  followed by its shortest path as numbered action names.
- `reached` or `unreached` for each reachability check. These name states the
  model must be able to reach, such as a completed run, a Migration, or a
  re-delivered arrival. An `unreached` line means an action has been disabled
  by mistake, and a pass from that model checks less than it claims.

It exits 0 when everything holds and is reached, 1 otherwise, and 2 when
`tla-ts` cannot check a model. The whole run takes about 50 seconds on a
many-core machine, most of it the intake model and the liveness checks.

`mutations.sh` first checks the models as written. Then it removes one guard of
the design at a time and requires the rules named beside that guard to break.
It reports a mutation `UNPROVEN` when its rule already breaks on the models as
written, `MISSED` when its rule still holds, `UNCOVERED` for a rule no mutation
reaches, `STALE` for a recorded finding that no longer reproduces, and `NEW` for
a rule that breaks and is not a recorded finding. Any of those fails the suite.
It takes about 75 seconds.

Both scripts run `tla-ts@0.0.8` through `pnpm dlx` on every core, so nothing is
installed into the workspace. `MODEL_DIR` points `check.sh` at a copy of the
models, and `RULES` limits it to named rules.

To see a result as a chart in plain words, use the pstack `/statechart` skill
on a model and its config, if that plugin is installed. It shows a broken rule
as its shortest path, and when every rule holds it draws how a run moves
between states. `/statechart` runs its own checker. `check.sh` is what decides
pass or fail.

## The models

Each model checks every behaviour of a small configuration. Two workers, a
retry limit of 2 (the design's 4, scaled down), and one crash or expired lease
per behaviour run through all three. Liveness rules assume workers keep
working and the lease sweep keeps running. Events, cancels, crashes and
Migrations are free never to happen.

### `DurableExecutor`: one run

```
Lifecycle --Started--> Wait A --+
          \            Wait B --+--> Join (an action that may fail)
           --Canceled--> Wait C --> Outlet (an action)
```

The two parallel Waits are the case ADR-0011 exists for, and the Join behind
both is the case it leaves open. Entity Eligibility may refuse the work below a
woken Wait or the Join, which claims an Exit. A Cancel Event claims the run and
routes it to the Canceled outlet, whose own Wait parks like any other. About
17,000 states.

| Rule | The promise | The harm when it breaks |
| --- | --- | --- |
| `WokenBranchIsNeverStranded` | A run never sleeps while one of its Waits holds a wake nobody has acted on. | The branch waits for another Wait's deadline, up to a year. |
| `SleepingRunHasADeadline` | A sleeping run always has an open Wait whose deadline will wake it. | The run sleeps until someone cancels it. |
| `EachWaitWokenOnce` | An Event, a timeout and a claim never both win the same Wait. | The work below the Wait runs twice. |
| `EachBranchRunsOnce` | The work below each Wait runs at most once. | A message below the Wait is sent twice. |
| `JoinRunsOnceAfterBothBranches` | The Join runs once, and only after both branches ran. | The Join reads output that does not exist yet, or runs twice. |
| `CanceledOutletEnteredOnceOnCancel` | The Canceled outlet is entered once, and only after a Cancel Event claimed the run. | Cancellation work runs twice, or on a run nobody cancelled. |
| `OneClaimWins` | A run's Cancel or Exit claim is written once, and the first wins. | A cancelled run is turned into an exited one, or back. |
| `NoStartedWorkAfterAClaim` | No Started-side work is admitted after a Cancel or Exit claim. | A canceled appointment still gets its reminder. |
| `NoCanceledWorkAfterExit` | An Exit claim also refuses the Canceled side. | An exited run sends cancellation messages. |
| `NothingCommitsAfterTheRunEnds` | Nothing commits after the run has ended. | A canceled run keeps doing work. |
| `OneTerminalRecord` | The run's terminal record is written once. | The run's status flips after it ended. |
| `NoWaitLeftOpenAfterTheRunEnds` | A run that has ended leaves no Wait parked. | The Runs view shows an ended run waiting, and its outlet work never runs. |
| `ExitHaltsEveryWait` | An exited run leaves no Wait parked. | A sibling branch stays parked on a run that has exited. |
| `EndMatchesWork` | A completed run ran the Join, a run a Cancel Event ended ran its outlet, and an exited run ran neither. | The Runs view reports work that never happened. |
| `FailedOnlyAfterRetriesSpent` | A run is marked failed only after its retries were spent on failures. | A transient error fails a run with no retry. |
| `LeaseHasAHolder` | A leased schedule row has a lease holder, and no other row does. | Two workers believe they own the run. |
| `EveryRunEnds` (liveness) | Every run eventually ends. | A run sits in progress forever. |
| `EveryWakeIsActedOn` (liveness) | Every wake is eventually run past, halted or cancelled. | A woken Wait is never acted on. |

### `Migration`: one run moved between versions

```
Lifecycle --> Above --> Wait --> Below
```

The run is pinned to version 1 or 2, and up to two Migrations move it. A pass
loads the pinned version once, and every write the Wait makes is fenced on that
version still being pinned. About 7,600 states.

| Rule | The promise | The harm when it breaks |
| --- | --- | --- |
| `AboveRunsOnce` | A Migration never re-runs a node above the Wait. | A message sent before the Wait is sent again. |
| `BelowRunsOnce` | The node below the Wait runs once. | It runs twice. |
| `BelowRunsThePinnedVersion` | The node below the Wait runs the definition of the version the run pins. | A migrated run runs the old step. |
| `EachHopWokenOnce` | Each park of the Wait is resumed by at most one Event or timeout. | The run resumes twice. |
| `ParkedUnderThePinnedVersion` | A sleeping run is parked on a row prepared from the version it pins, unless its migrate wake is still on the way. | A migrated run keeps the old version's delay. |
| `WokenWaitIsNeverStranded` | A run never sleeps while its Wait holds a wake. | The run waits for a deadline after it was woken. |
| `OneTerminalRecord` | The terminal record is written once. | The status flips after the run ended. |
| `FailedOnlyAfterRetriesSpent` | A run is marked failed only after its retries were spent on failures. | A Migration fails a run. |
| `LeaseHasAHolder` | A leased row has a holder. | Two workers own the run. |
| `EveryRunEnds` (liveness) | Every run eventually ends. | A migrated run loops forever. |

### `Intake`: the inbox, delivery and Concurrency

One workflow and one Entity. The host raises two Start Events and a Cancel
Event, and sends one Start twice with the same idempotency key. An arrival
enters the inbox through `app.events.send`, which writes its delivery's schedule
row in the same transaction, or inside the host's own transaction, which leaves
the poll to schedule the delivery. A delivery's lifecycle write and its memo
row are separate transactions, so a crash between them runs the delivery again.
Both Concurrency modes, newest wins and first wins, are checked. An Execution's
own run is one step here, because `DurableExecutor` checks what happens inside
one. About 125,000 states.

| Rule | The promise | The harm when it breaks |
| --- | --- | --- |
| `DuplicateSendIsOneArrival` | Sending the same arrival twice puts one row in the inbox. | A retried send starts two runs. |
| `EachArrivalOpensAtMostOneRun` | Each Start arrival opens at most one Execution, however often its delivery runs. | A crash during delivery starts a second run. |
| `OneLiveRunPerEntity` | Under one-at-a-time Concurrency, at most one run per Entity is live. | Two reminder sequences run for one appointment. |
| `EveryOpenRunIsScheduled` | Every open Execution has a schedule row. | A run is opened that nothing will ever execute. |
| `SupersededRunsStop` | A superseded run does no more work. | A rescheduled appointment gets the old reminders too. |
| `EveryArrivalIsDelivered` (liveness) | Every arrival in the inbox is eventually delivered. | An Event the host sent never reaches a workflow. |
| `EveryRunEnds` (liveness) | Every opened run eventually ends. | A claimed run never reaches its outlet. |

## Bounds and assumptions

- The bounds above: two workers, two versions and two Migrations, three
  arrivals, a retry limit of 2, one fault per behaviour.
- Counters stop one past the retry limit, because nothing compares them further.
- The `CountersBounded` constraints cap observer counters at 2 so a mutated
  model stays finite. In the models as written, every counter stays at most 1
  whenever its rule holds, so the caps cut only states where a rule has already
  broken.
- Each guarded write is atomic. That holds in the design because each is one
  SQL statement, or one transaction that locks the schedule row first. The park
  producer's `select ... for update` on the schedule row is what makes a wake
  one step against a release; without it, the producer's conditional update can
  miss a release in flight.
- `NOTIFY` is not modelled. The design treats it as a latency optimisation and
  relies on the poll for correctness, which is what the models check: a worker
  finds every due row by polling.
- Clock time is abstract. A timeout is "the deadline passed". Lease length,
  heartbeat interval and backoff are not modelled.

## Coverage record

Each guard the design depends on is a named operator in its model, so a reader
can find it and a mutation can remove it.

| Model part | Design doc section | Existing code the design reuses |
| --- | --- | --- |
| `DurableExecutor`: `Claim`, `ClaimWhenDue`, `ParkIsDue` | Design A, "The invocation", step 1 | |
| `LeaseHeldBy`, `Fenced` (all models) | "The runtime", `run(step, fn)` | |
| `VisitStarted`, `VisitCanceled`, `RunsPast`, `RunsOutlet` | "A park is a value"; "The runtime", `waitForEvent` | `openResume` and `createWaitState` fences in `engine/wait.ts`; `startWait` in `repo/waits.ts` |
| `StartedSideAdmits`, `CanceledSideAdmits` | "Cancellation"; CONTEXT.md "Canceled Branch" | `claimAdmits` in `repo/runs.ts` |
| `EnterCanceledOutlet` | "Cancellation" | the `lifecycle-check` step in `engine/cancel-boundary.ts` |
| `AdmitJoin`, `ExitBeforeJoin`, `ExitBeforeBranch`, `ClaimIsFree` | "Exit claim"; CONTEXT.md "Entity Eligibility" | `admitNode` in `engine/scheduler.ts`; `requestExit` in `repo/runs.ts` |
| `JoinSucceeds`, `JoinFails`, `Release` | "The invocation", step 4; "Retries" | `finishRun` in `repo/runs.ts` |
| `ReleaseReadsWaitRows`, `ReleaseReadsWaitRow` | "The invocation", step 4 | |
| `LeaseExpires`, `SweepDeadLease`, `Crash` (all models) | "Lease and liveness" | |
| `EventWake`, `WakeIsUnclaimed` | "Resolving a park" (the `status = 'waiting'` update) | `claimWaitState` in `repo/waits.ts` |
| `CancelEvent` | "Cancellation" | `requestCanceledOutlet` in `lifecycle/cancel.ts` |
| `PolicyCancel`, `RunInFlight` | "Cancellation", the policy cancel | `cancelInFlightRuns` in `executions/end-runs.ts` |
| `Migration`: `Repin`, `RepinNeedsAPark` | "Migration"; ADR-0019 | `repinVersion` in `repo/runs.ts`; `migrateExecutions` in `migration/migrate.ts` |
| `Migration`: `MigrateWake`, `Prepare`, `Park`, `StillPinned` | "Migration" | `reparkWaitState` and `markExecutionRunning` fences in `engine/wait.ts` |
| `Intake`: `SendViaApp`, `SendInHostTransaction`, `PollInbox`, `InboxKeyIsUnique` | Section 7.1 and 7.3 | |
| `Intake`: `ClaimDelivery`, `LifecycleStep`, `RecordMemo`, `FinishDelivery` | Section 7.2 | `runEventListener` in `lib/inngest/event-listener-function.ts` |
| `Intake`: `StartWrite`, `DeliveryIdIsUnique`, `ExecutionAndScheduleTogether` | Section 7.1; scenario S13 | `answerFromCommittedDecision` in `lifecycle/deliver-event.ts`; `startForEntity` in `repo/index.ts` |
| `Intake`: Concurrency in `StartWrite`, `SupersedeDropsSchedule` | CONTEXT.md "Concurrency", "Superseded" | `startWithConcurrency` in `lifecycle/concurrency.ts` |
| `Intake`: `CancelWrite` | "Cancellation" | `requestCancelForEntity` in `repo/runs.ts` |

Last confirmed against: the design doc at `afc0ce3c`, and the existing code at
`a92cea15` (`main`). Move these two commits forward only after you have read
the covered sections and files at the new commit and confirmed that the models
still describe them. When the executor is built, add its files to the last
column and replace the doc sections with the code that implements them.

## Telling a real bug from a modelling error

A broken rule is a claim about the design until you have checked the path
against the design. Walk the printed path one action at a time, and for each
action find the sentence in the design doc, or the line of code, that permits
it.

- Every step is permitted by the design: the bug is real. Report it as the
  path in the design's words. Do not weaken the rule or narrow the model to make
  it pass. Change the design only when the person who owns it asks.
- A step the design forbids, or two writes the model treats as separate that
  the design makes one transaction: the model is wrong. Fix the model, then
  rerun both scripts.

## When a design change breaks a rule

The change is not ready. Report the rule, the path in the design's words, and
whether you judged it a real bug. Leave the sync commits and the coverage record
where they are, because the models no longer describe a design anyone has
agreed to. The person who owns the design decides whether to change the design
or accept the finding. An accepted finding goes in Known findings and in the
`findings` list in `mutations.sh`.

## Changing a model for an intended design change

1. Edit the action that models the changed section. Keep each guard the design
   depends on as a named operator, one per statement in the design. When two
   actions share a guard and the change touches only one of them, give that
   action its own operator first.
2. A new promise gets a new `INVARIANT` or `PROPERTY` in the model's `.cfg`, a
   row in the Rules table, and a row in `mutations.sh` that breaks it. A new
   path the model must be able to take gets a `\* REACH` line in the `.cfg` and a
   predicate in the model.
3. Run `check.sh` and `mutations.sh`. Every check must hold except the known
   findings, every reachability check must be reached, and the mutation suite
   must exit 0.
4. Update the coverage record and move the sync commits.

## Known findings

These break on the design as written. Each is listed in `mutations.sh`, which
fails if one stops reproducing.

- **`Migration` `FailedOnlyAfterRetriesSpent`: a Migration spends a retry.** The
  doc's "Migration" paragraph ends a pass whose version fence is refused "as a
  retry", and "Retries" counts an attempt for each retry. The shortest path: a
  worker's lease expires, which counts one attempt. A second worker claims the
  run, runs the node above the Wait, and parks the Wait. A Migration repins the
  run and sends its migrate wake while that pass is still running. The pass
  reads the migrate wake, its fence refuses the re-park because the run now pins
  the other version, and the release counts a second attempt and marks the run
  failed. No step ever failed. A refused version fence would need to re-queue
  the run without counting an attempt.
- **`DurableExecutor` `NoWaitLeftOpenAfterTheRunEnds`: a failing Join abandons
  the Canceled outlet.** The Join is admitted before a Cancel Event claims the
  run, which the design allows ("work already admitted may finish"). The claim
  lands, the next pass enters the Canceled outlet and parks Wait C, and the
  admitted Join then fails on its last retry. The release marks the run failed:
  the Outlet never runs, and Wait C stays parked on a run that has ended. The
  design says the release writes `failed` when retries are spent. It does not
  say what happens to a Canceled outlet in progress, or to Waits still parked.

`DurableExecutor` `FailedOnlyAfterRetriesSpent` was the first finding of this
check: the claim counted an attempt each time a wake re-queued the run. The
design doc fixed it at `d652b52c`, and the `claim-counts-an-attempt` mutation
keeps it fixed.

## Not covered

- Several workflows subscribed to one Event, and Wait Subscriptions fed by the
  inbox (the delivery's wait-candidate pages).
- More than one Execution inside the run model. Concurrency is checked in
  `Intake`, with each run reduced to one step.
- Handler sub-steps inside one node, and the per-Event flow control of section
  7.4.
- Exit claimed before an Execution opens (admission Eligibility), and a Wait
  that changes mode under a Migration.
- The SQLite and Cloudflare Worker drivers, `NOTIFY` latency, database
  failover, and lease, heartbeat and backoff timing.
