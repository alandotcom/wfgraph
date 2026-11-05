---
name: verify-durable-executor
description: Model-check the Postgres executor proposed to replace Inngest (Design A and the event inbox in docs/internal/plans/separate-event-intake-from-durable-execution.md) with TLA+ models run by tla-ts. Use when a change touches that design's claim, lease, pass, release, park resolution, cancellation, Exit claim, retries, Migration (including a Wait that changes mode), inbox, delivery fan-out to several workflows, Wait wakes from an arrival, or Concurrency rules, when the executor it describes is being built, or when a change touches the existing code the design reuses (claimWaitState, openResume's version fence, admitNode, finishRun, startForEntity, repinVersion, answerFromCommittedDecision). Triggers on "verify the executor", "model-check the design", "does the release still hold", or a claim that a run cannot be stranded, woken twice, opened twice, or run after it ended.
---

# Verify the durable executor design

The design doc proposes an executor the library owns: a schedule row per
Execution that workers claim under a lease, a pass that replays the run against
a step memo, producers that wake a Wait by writing its wait row, and an inbox
whose deliveries run on the same executor. The order in which those writes land
decides whether a run is stranded, woken twice, opened twice, or run after it
ended. No unit test explores every order. This skill checks every order, up to
stated bounds, with four TLA+ models and `tla-ts`, a TLC-compatible model
checker that runs on Node with no JVM.

Read this whole file before running anything.

## When a change needs this check

Run the check when a change touches any design section or file in the coverage
record. Run it on every edit to the release, claim, park-resolution, retry or
Concurrency rules, because each of those has broken a rule at least once.

Find out whether the verification is stale before you trust it:

```sh
git diff --stat -- docs/internal/plans/separate-event-intake-from-durable-execution.md
git log --oneline 25e215b0.. -- docs/internal/plans/separate-event-intake-from-durable-execution.md
git log --oneline a92cea15.. -- \
  packages/core/src/backend/services/executions/repo/waits.ts \
  packages/core/src/backend/services/executions/repo/runs.ts \
  packages/core/src/backend/services/executions/repo/index.ts \
  packages/core/src/backend/services/executions/end-runs.ts \
  packages/core/src/backend/services/workflows/lifecycle/cancel.ts \
  packages/core/src/backend/services/workflows/lifecycle/concurrency.ts \
  packages/core/src/backend/services/workflows/lifecycle/deliver-event.ts \
  packages/core/src/backend/services/workflows/lifecycle/resume-waits.ts \
  packages/core/src/backend/lib/inngest/event-listener-function.ts \
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
`tla-ts` cannot check a model. The whole run takes about a minute on a
many-core machine, most of it the intake model and the liveness checks.

`mutations.sh` first checks the models as written. Then it removes one guard of
the design at a time and requires the rules named beside that guard to break.
It reports a mutation `UNPROVEN` when its rule already breaks on the models as
written, `MISSED` when its rule still holds, `UNCOVERED` for a rule no mutation
reaches, `STALE` for a recorded finding that no longer reproduces, and `NEW` for
a rule that breaks and is not a recorded finding. Any of those fails the suite.
It takes about 90 seconds.

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
per behaviour run through all four. Liveness rules assume workers keep
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
routes it to the Canceled outlet, whose own Wait parks like any other. A Join
whose retries run out fails its node, and the run goes on. About 19,400 states.

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
| `CancelClaimRunsItsOutlet` | A run a Cancel Event claimed ends only after its Outlet ran, unless a policy cancel ended it first. | Cancellation work is abandoned because another step failed. |
| `ExitHaltsEveryWait` | An exited run leaves no Wait parked. | A sibling branch stays parked on a run that has exited. |
| `EndMatchesWork` | A completed run ran the Join, a run a Cancel Event ended ran its outlet, an exited run ran neither, and a failed run has a failed Join and no claim. | The Runs view reports work that never happened. |
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
version still being pinned. A refused fence ends the pass and re-queues the run
without counting an attempt. Each version's Wait is event-mode or delay-mode,
and all four pairings are checked, so a Migration can change the Wait's mode.
About 17,200 states.

One behaviour the model allows and no rule forbids: an Event that claims the
old event-mode park after the repin and before the migrate wake still resumes
the run, even when the version the run now pins gives the Wait delay mode
(`ReachEventResumesAcrossAModeChange`). The Event arrived while the run was
parked on a subscription to it, which is why the design lets it through.

| Rule | The promise | The harm when it breaks |
| --- | --- | --- |
| `AboveRunsOnce` | A Migration never re-runs a node above the Wait. | A message sent before the Wait is sent again. |
| `BelowRunsOnce` | The node below the Wait runs once. | It runs twice. |
| `BelowRunsThePinnedVersion` | The node below the Wait runs the definition of the version the run pins. | A migrated run runs the old step. |
| `EachHopWokenOnce` | Each park of the Wait is resumed by at most one Event or timeout. | The run resumes twice. |
| `ParkedUnderThePinnedVersion` | A sleeping run is parked on a row prepared from the version it pins, unless its migrate wake is still on the way. | A migrated run keeps the old version's delay. |
| `ParkedInThePinnedMode` | A sleeping run is parked in the mode its pinned version gives the Wait, unless its migrate wake is still on the way. | A Wait migrated to delay mode still accepts Events, or the reverse. |
| `EventOnlyWakesAnEventPark` | An Event wakes only a Wait parked in event mode. | A delay Wait ends early because an Event arrived. |
| `WokenWaitIsNeverStranded` | A run never sleeps while its Wait holds a wake. | The run waits for a deadline after it was woken. |
| `OneTerminalRecord` | The terminal record is written once. | The status flips after the run ended. |
| `FailedOnlyAfterRetriesSpent` | A run is marked failed only after its retries were spent on failures. | A Migration fails a run. |
| `LeaseHasAHolder` | A leased row has a holder. | Two workers own the run. |
| `EveryRunEnds` (liveness) | Every run eventually ends. | A migrated run loops forever. |

### `Delivery`: one arrival delivered to several workflows

One arrival of Event X, delivered as `runEventListener` delivers it today:
per subscribing workflow, a lifecycle step, then every page of Wait candidates
saved, then each saved page offered the arrival. Two workflows subscribe:

- W1 starts on X with newest-wins Concurrency, and its runs have a Wait on X.
  The run X supersedes is parked on that Wait, and the run X starts reaches the
  same Wait while the delivery is still going.
- W2 cancels on X behind a Cancel Filter that may decline it. Its run R2 waits
  on X twice in a row, and if the Cancel claims it, its Canceled outlet parks a
  third Wait on X. Its run R3 belongs to another Entity and waits on X once.

Pages hold one row each. A worker can crash between waking a page and writing
that step's memo row, so a page can be offered twice. About 2,200 states.

| Rule | The promise | The harm when it breaks |
| --- | --- | --- |
| `NoWakeInTheRunItStarted` | An arrival never wakes a Wait in a run it started. | A run started by an Event skips its own Wait for the next one. |
| `NoWakeInARunItSettled` | An arrival never wakes a Wait in a run it superseded or claimed, including a Wait the claimed run's Canceled outlet parks. | A canceled run's outlet Wait resumes on the Event that canceled it. |
| `NoSecondWaitFromOneArrival` | One arrival never resumes two Waits of the same run one after the other. | One Event satisfies "wait for two payments". |
| `EachWaitWokenOnce` | An arrival wakes each Wait at most once, however often its delivery runs. | The work below the Wait runs twice. |
| `SurvivingWaitsAreWoken` (liveness) | Every Wait of a surviving run that was parked on X when it arrived is woken by it. | A run misses the Event it was waiting for. |

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
  arrivals in `Intake`, one arrival fanned out to two workflows in `Delivery`
  with pages of one row, a retry limit of 2, one fault per behaviour.
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
| `JoinSucceeds`, `JoinFails`, `Release`, `RetriesSpent`, `FailedNodeEndsRun` | "The invocation", step 4; "Retries" | `finishRun` in `repo/runs.ts`; the terminal status `executeWorkflow` chooses in `engine/terminal-record.ts` |
| `ReleaseReadsWaitRows`, `ReleaseReadsWaitRow` | "The invocation", step 4 | |
| `LeaseExpires`, `SweepDeadLease`, `Crash` (all models) | "Lease and liveness" | |
| `EventWake`, `WakeIsUnclaimed` | "Resolving a park" (the `status = 'waiting'` update) | `claimWaitState` in `repo/waits.ts` |
| `CancelEvent` | "Cancellation" | `requestCanceledOutlet` in `lifecycle/cancel.ts` |
| `PolicyCancel`, `RunInFlight` | "Cancellation", the policy cancel | `cancelInFlightRuns` in `executions/end-runs.ts` |
| `Migration`: `Repin`, `RepinNeedsAPark` | "Migration"; ADR-0019 | `repinVersion` in `repo/runs.ts`; `migrateExecutions` in `migration/migrate.ts` |
| `Migration`: `MigrateWake`, `Prepare`, `Park`, `StillPinned` | "Migration" | `reparkWaitState` and `markExecutionRunning` fences in `engine/wait.ts` |
| `Migration`: `Release`, `FenceRefusalCountsNoAttempt` | "Migration"; scenario S6 | |
| `Intake`: `SendViaApp`, `SendInHostTransaction`, `PollInbox`, `InboxKeyIsUnique` | Section 7.1 and 7.3 | |
| `Intake`: `ClaimDelivery`, `LifecycleStep`, `RecordMemo`, `FinishDelivery` | Section 7.2 | `runEventListener` in `lib/inngest/event-listener-function.ts` |
| `Intake`: `StartWrite`, `DeliveryIdIsUnique`, `ExecutionAndScheduleTogether` | Section 7.1; scenario S13 | `answerFromCommittedDecision` in `lifecycle/deliver-event.ts`; `startForEntity` in `repo/index.ts` |
| `Intake`: Concurrency in `StartWrite`, `SupersedeDropsSchedule` | CONTEXT.md "Concurrency", "Superseded" | `startWithConcurrency` in `lifecycle/concurrency.ts` |
| `Intake`: `CancelWrite` | "Cancellation" | `requestCancelForEntity` in `repo/runs.ts` |
| `Migration`: `EventWakeNeedsAnEventPark` | "Resolving a park"; ADR-0019 | the `wait_type = 'event'` condition in `claimWaitState`, `repo/waits.ts` |
| `Migration`: `ReparkMode` | "Migration"; ADR-0019 | `reparkWait` in `repo/waits.ts` |
| `Delivery`: `Lifecycle`, `Life1`, `Life2`, `Settled` | Section 7.2; CONTEXT.md "Precedence" | `runEventListener` and `settledExecutionIds` in `lib/inngest/event-listener-function.ts`; `applyLifecycleRules` in `lifecycle/deliver-event.ts` |
| `Delivery`: `ScanAllPages`, `Candidate`, `ExcludeSettledRuns`, `SavePagesBeforeWaking` | Section 7.2 | `listWaitCandidatePage` in `lifecycle/deliver-event.ts`; `listWaitsForEvent` in `repo/waits.ts` |
| `Delivery`: `WakeSavedPage`, `RecordWokenPage`, `WakeIsUnclaimed` | Section 7.2; "The runtime", `run(step, fn)` | `deliverWaitCandidates` in `lifecycle/deliver-event.ts`; `resumeWaitsMatchingEvent` in `lifecycle/resume-waits.ts`; `claimWaitingStateById` in `repo/waits.ts` |

Last confirmed against: the design doc at `25e215b0`, and the existing code at
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

None. Every rule holds on the design as written. `mutations.sh` keeps a
`findings` list for a rule that breaks and has been accepted as a finding, and
fails when that list disagrees with what `check.sh` reports.

Three earlier findings are fixed in the design doc, and a mutation puts each
back to show the rule still catches it:

- `DurableExecutor` `FailedOnlyAfterRetriesSpent`: the claim counted an attempt
  each time a wake re-queued the run, so waking a Wait spent a retry. Fixed at
  `d652b52c`. Mutation: `claim-counts-an-attempt`.
- `DurableExecutor` `NoWaitLeftOpenAfterTheRunEnds` and
  `CancelClaimRunsItsOutlet`: a Join admitted before a Cancel Event failed on its
  last retry after the outlet's Wait had parked, and the release ended the run
  `failed`, so the Outlet never ran. Fixed at `e47ef6f0`: a step whose retries
  run out fails its node, and the run goes on to its outlet. Mutation:
  `failed-node-ends-the-run`.
- `Migration` `FailedOnlyAfterRetriesSpent`: a refused version fence counted as
  a retry, so a Migration landing during a pass, after one expired lease, marked
  the run failed with no step having failed. Fixed at `25e215b0`: a refused
  fence re-queues the run with the attempt counter unchanged. Mutation:
  `fence-refusal-counts-an-attempt`.

## Not covered

- Two arrivals delivered at the same time to one workflow. `Delivery` has one
  arrival; `DurableExecutor` checks that two producers never both wake one Wait.
- A Wait's match expression and Connection filter. `Delivery` treats every
  candidate as matching.
- More than one Execution inside the run model. Concurrency is checked in
  `Intake`, with each run reduced to one step.
- Handler sub-steps inside one node.
- A delivery's attempt limit. `Intake` re-runs a delivery after a crash or an
  expired lease, and never gives up on one.
- Exit claimed before an Execution opens (admission Eligibility).
- The SQLite and Cloudflare Worker drivers, `NOTIFY` latency, database
  failover, and lease, heartbeat and backoff timing.
