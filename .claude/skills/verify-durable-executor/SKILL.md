---
name: verify-durable-executor
description: Model-check the database executor that replaces Inngest (Design A and the event inbox in docs/internal/plans/separate-event-intake-from-durable-execution.md) with TLA+ models run by tla-ts. Use when a change touches that design's claim, lease, pass, release, park resolution, cancellation, Exit claim, retries, Migration (including a Wait that changes mode), inbox, delivery fan-out to several workflows, Wait wakes from one or several arrivals, Wait match expressions, steps inside a handler, admission Entity Eligibility, Concurrency, cron schedule timers and how Publish and pause rewrite them, the inbox and run-history retention sweeps, or the drivers' leases, heartbeats, polling and Worker platform limits, when a change touches the executor's code (packages/core/src/backend/executor, the Worker's tick driver in packages/core/src/backend/worker.ts, the schedule, step memo and fenced writes in services/executions/repo and persistence/sqlite/executions, the engine's parked Waits), or when a change touches the existing code the design reuses (claimWaitState, openResume's version fence, admitNode, endRun, startForEntity, repinVersion, answerFromCommittedDecision). Triggers on "verify the executor", "model-check the design", "does the release still hold", or a claim that a run cannot be stranded, woken twice, opened twice, or run after it ended.
---

# Verify the durable executor design

The design doc proposes an executor the library owns: a schedule row per
Execution that workers claim under a lease, a pass that replays the run against
a step memo, producers that wake a Wait by writing its wait row, and an inbox
whose deliveries run on the same executor. The order in which those writes land
decides whether a run is stranded, woken twice, opened twice, or run after it
ended. No unit test explores every order. This skill checks every order, up to
stated bounds, with nine TLA+ models and `tla-ts`, a TLC-compatible model
checker that runs on Node with no JVM.

Read this whole file before running anything.

## When a change needs this check

Run the check when a change touches any design section or file in the coverage
record. Run it on every edit to the release, claim, park-resolution, retry or
Concurrency rules, because each of those has broken a rule at least once.

Find out whether the verification is stale before you trust it:

```sh
git diff --stat -- docs/internal/plans/separate-event-intake-from-durable-execution.md
git log --oneline b014dc55.. -- docs/internal/plans/separate-event-intake-from-durable-execution.md
git log --oneline b014dc55.. -- \
  packages/core/src/backend/executor \
  packages/core/src/backend/worker.ts \
  packages/core/src/backend/services/executions/driver.ts \
  packages/core/src/backend/services/workflows/lifecycle \
  packages/core/src/backend/services/workflows/migration/migrate.ts \
  packages/core/src/backend/services/executions/repo/schedule.ts \
  packages/core/src/backend/services/executions/repo/fenced-writes.ts \
  packages/core/src/backend/services/executions/repo/fencing.ts \
  packages/core/src/backend/services/executions/repo/release-policy.ts \
  packages/core/src/backend/services/executions/repo/inbox.ts \
  packages/core/src/backend/services/executions/repo/inbox-policy.ts \
  packages/core/src/backend/services/executions/repo/node-logs.ts \
  packages/core/src/backend/services/executions/repo/waits.ts \
  packages/core/src/backend/services/executions/repo/runs.ts \
  packages/core/src/backend/services/executions/repo/retention-policy.ts \
  packages/core/src/backend/services/executions/repo/retention.ts \
  packages/core/src/backend/executor/upkeep.ts \
  packages/core/src/backend/services/executions/repo/claims.ts \
  packages/core/src/backend/services/executions/repo/admission.ts \
  packages/core/src/backend/services/executions/repo/cron.ts \
  packages/core/src/backend/services/executions/repo/cron-policy.ts \
  packages/core/src/backend/services/executions/repo/index.ts \
  packages/core/src/backend/persistence/sqlite/executions \
  packages/core/src/backend/lib/db/schema.ts \
  packages/core/src/backend/engine/core.ts \
  packages/core/src/backend/engine/wait.ts \
  packages/core/src/backend/engine/runtime.ts \
  packages/core/src/backend/engine/scheduler.ts \
  packages/core/src/backend/engine/cancel-boundary.ts \
  packages/core/src/backend/engine/db-store.ts \
  packages/core/src/backend/engine/durable.ts \
  packages/core/src/backend/engine/step-log.ts \
  packages/core/src/backend/services/executions/end-runs.ts \
  packages/core/src/backend/services/executions/driver.ts \
  packages/core/src/backend/services/workflows/lifecycle/cancel.ts \
  packages/core/src/backend/services/workflows/lifecycle/concurrency.ts \
  packages/core/src/backend/services/workflows/lifecycle/deliver-event.ts \
  packages/core/src/backend/services/workflows/lifecycle/resume-waits.ts \
  packages/core/src/backend/executor/delivery-fanout.ts \
  packages/core/src/backend/services/executions/send-event.ts \
  packages/core/src/backend/services/integrations/webhook-intake.ts \
  packages/core/src/backend/lib/inngest/event-forwarder.ts \
  packages/core/src/backend/services/workflows/migration/migrate.ts \
  packages/core/src/backend/services/workflows/publish.ts \
  packages/core/src/backend/services/workflows/repo.ts \
  packages/core/src/backend/services/workflows/bulk-actions.ts \
  packages/core/src/backend/persistence/sqlite/workflows.ts
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
`tla-ts` cannot check a model. The whole run takes about four minutes on a
many-core machine, most of it the `Arrivals` and `Intake` models.

`mutations.sh` first checks the models as written. Then it removes one guard of
the design at a time and requires the rules named beside that guard to break.
It reports a mutation `UNPROVEN` when its rule already breaks on the models as
written, `MISSED` when its rule still holds, `UNCOVERED` for a rule no mutation
reaches, `STALE` for a recorded finding that no longer reproduces, `NEW` for
a rule that breaks and is not a recorded finding, and `AMBIGUOUS` when a
mutation's text occurs more than once in its model, since the mutation would
then change only the first occurrence. Any of those fails the suite.
It takes about six minutes.

Both scripts run `tla-ts@0.0.8` through `pnpm dlx` on every core, so nothing is
installed into the workspace. `MODEL_DIR` points `check.sh` at a copy of the
models, and `RULES` limits it to named rules.

To see a result as a chart in plain words, use the pstack `/statechart` skill
on a model and its config, if that plugin is installed. It shows a broken rule
as its shortest path, and when every rule holds it draws how a run moves
between states. `/statechart` runs its own checker. `check.sh` is what decides
pass or fail.

## The models

Each model checks every behaviour of a small configuration. Two workers and one
crash or expired lease per behaviour run through all nine, and every model
that counts retries uses a limit of 2 (the design's 4, scaled down). Liveness
rules assume workers keep working and the lease sweep keeps running. Events,
cancels, crashes, Migrations, Publishes and pauses are free never to happen.

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
parked on a subscription to it. The design's owner has accepted this; do not
add a rule against it without asking.

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

One arrival of Event X, delivered as `fanOutDelivery` delivers it today:
per subscribing workflow, a lifecycle step, then every page of Wait candidates
saved, then each saved page offered the arrival. Two workflows subscribe:

- W1 starts on X with newest-wins Concurrency, and its runs have a Wait on X.
  The run X supersedes is parked on that Wait, and the run X starts reaches the
  same Wait while the delivery is still going.
- W2 cancels on X behind a Cancel Filter that may decline it. Its run R2 waits
  on X twice in a row, and if the Cancel claims it, its Canceled outlet parks a
  third Wait on X. Its run R3 belongs to another Entity and waits on X once.

Pages hold one row each. A worker can crash between waking a page and writing
that step's memo row, so a page can be offered twice. A third workflow, not
modelled, may fail on every retry, so the delivery may settle failed after W1
and W2 received the arrival; its schedule row is then kept `settled` with its
memo, and one resend of the key reopens it. About 3,800 states.

| Rule | The promise | The harm when it breaks |
| --- | --- | --- |
| `NoWakeInTheRunItStarted` | An arrival never wakes a Wait in a run it started. | A run started by an Event skips its own Wait for the next one. |
| `NoWakeInARunItSettled` | An arrival never wakes a Wait in a run it superseded or claimed, including a Wait the claimed run's Canceled outlet parks. | A canceled run's outlet Wait resumes on the Event that canceled it. |
| `NoSecondWaitFromOneArrival` | One arrival never resumes two Waits of the same run one after the other, including across a resend that reopens its failed delivery. | One Event satisfies "wait for two payments", or a vendor's resend wakes a run the first delivery already moved on. |
| `EachWaitWokenOnce` | An arrival wakes each Wait at most once, however often its delivery runs. | The work below the Wait runs twice. |
| `SurvivingWaitsAreWoken` (liveness) | Every Wait of a surviving run that was parked on X when it arrived is woken by it. | A run misses the Event it was waiting for. |

### `Intake`: the inbox, delivery and Concurrency

One workflow and one Entity. The host raises two Start Events and a Cancel
Event, and sends one Start twice with the same idempotency key. An arrival
enters the inbox through `app.events.send`, which writes its delivery's schedule
row in the same transaction, or inside the host's own transaction, which leaves
the poll to schedule the delivery. The Bearer-key route, webhook intake and the
Inngest forwarder write the same way `app.events.send` does, each with its own
idempotency key: the sender's `id`, the message id an integration's webhook reads, per Connection, and
the Inngest event id. A delivery's lifecycle write and its memo
row are separate transactions, so a crash between them runs the delivery again.
Both Concurrency modes, newest wins and first wins, are checked. Admission
Entity Eligibility decides before Concurrency, and the host's resolver is asked
again on every attempt, so a re-run delivery may get a different answer. An
Execution's own run is one step here, because `DurableExecutor` checks what
happens inside one.

Each inbox row records the order it was received in, and the arrivals are sent
in every order, so a delivery held back can run after one received later. The
Cancel claims a run whose start was received no later than it, and a start
delivered after a Cancel received no earlier than it opens its run already
claimed. Each side is one atomic step, which on PostgreSQL the Entity's
advisory lock makes true.

The retention sweeps of decisions 7 and 8 delete rows at any moment their
guards allow, which stands for every choice of the two windows and every batch
order. Those guards are:

- **The inbox sweep** deletes a settled inbox row, never a `pending` one.
- **The run sweep** deletes an ended Execution only once the inbox row that
  opened it is gone.
- **The audit sweep** deletes a Refused Start's audit row, including the Entity
  admission refusal a redelivery reads, only once the inbox row it names is
  gone.

An inbox row outlives a run window in three ways: `pending` through retries, a
`failed` row a resend reopens with its old `received_at`, or a settled row a
full inbox batch left behind. The model needs no separate case for any of them,
because nothing forces the inbox sweep to run. The inbox sweep takes the
once-sent Start alone, since a send after the sweep is a new arrival under a
new id (ADR-0022) that would double the state space. About 1,620,000 states.

| Rule | The promise | The harm when it breaks |
| --- | --- | --- |
| `DuplicateSendIsOneArrival` | Two inbox rows never hold one idempotency key, so sending the same arrival twice puts one row in the inbox. | A retried send starts two runs. |
| `OneRunPerInboxRow` | No inbox row ever has two Executions, however often its delivery runs and whatever the retention sweeps delete. | A crash during delivery, or a redelivery after the run sweep deleted the first run, starts a second run. |
| `AdmissionDecidedOnce` | An arrival Entity Eligibility refused never later opens a run, even after the audit sweep. | A retried delivery starts a run for an ineligible Entity. |
| `RefusedArrivalChangesNothing` | An arrival Entity Eligibility refused supersedes nothing. | An ineligible reschedule cancels the reminders already running. |
| `OneLiveRunPerEntity` | Under one-at-a-time Concurrency, at most one run per Entity is live. | Two reminder sequences run for one appointment. |
| `EveryOpenRunIsScheduled` | Every open Execution has a schedule row. | A run is opened that nothing will ever execute. |
| `SupersededRunsStop` | A superseded run does no more work. | A rescheduled appointment gets the old reminders too. |
| `FailedArrivalStaysSettled` | A delivery that failed for good (a refused payload or spent retries) is never scheduled again, except by a resend of its key. | The poll reads a failed row as one a host inserted and delivers it forever. |
| `NoResendOfAFailedKeyIsLost` | A resend of a key whose delivery failed is delivered again, not answered as a duplicate. | A webhook that failed during an outage is lost when the vendor resends it. |
| `CancelClaimsOnlyEarlierRuns` | Only the Cancel arrival claims runs, by its own claim or at a start delivered after it, however often its delivery runs the claim. | A Cancel re-run after a crash cancels a run that opened after it arrived. |
| `CancelClaimsOnlyEarlierArrivals` | The Cancel claims no run whose start was received after it, whichever is delivered first. | A held-back Cancel cancels an appointment booked after the cancellation. |
| `NoEarlierStartEscapesTheCancel` | Once the Cancel is decided, no run whose start was received no later than it is left running, whichever is delivered first. | A booking whose delivery was retried runs its reminders after the cancellation. |
| `EveryArrivalIsDelivered` (liveness) | Every arrival in the inbox is eventually delivered. | An Event the host sent never reaches a workflow. |
| `EveryRunEnds` (liveness) | Every opened run eventually ends. | A claimed run never reaches its outlet. |

### `Arrivals`: two arrivals at once, and Wait match expressions

Two arrivals of Event X, with payloads `a` and `b`, are delivered at the same
time to one workflow. Run R waits on X and then on X again; run Q waits on X
once. Every combination of the two Waits' matches is checked: the payloads each
accepts. A Migration may re-park Q once, with a new match and a new token,
between an arrival's scan and its wake. Each arrival offers its saved
candidates as `resumeWaitsMatchingEvent` does: evaluate the saved match, claim
with the saved token, and on a rotated token re-read the row and evaluate the
current match. About 511,000 states.

| Rule | The promise | The harm when it breaks |
| --- | --- | --- |
| `WakeOnlyOnAMatch` | A Wait is woken only by an arrival its match in force accepts. | A Wait migrated to a narrower match resumes on an Event it now rejects. |
| `EachWaitWokenOnce` | A Wait is woken at most once, whichever arrival wakes it. | Two Events both resume one Wait, and the work below it runs twice. |
| `NoSecondWaitFromOneArrival` | One arrival never resumes two Waits of the same run one after the other. | One Event satisfies "wait for two payments". |
| `NoMatchingParkMissed` | An arrival never passes over a waiting row its current match accepts, including one re-parked since the scan. | A Migration landing mid-delivery makes a run miss the Event it waits for. |
| `EveryDeliveryEnds` (liveness) | Both deliveries end. | A delivery loops on its candidates. |

### `Handler`: the steps inside one node

One node opens its log row in a `log-open` step, reads a value from vendor A in
a `read` step, sends it to vendor B in a `send` step with an idempotency key
(ADR-0009), and closes its log row with a direct store write. Vendor A may
answer differently each time, or throw a retriable error. The send may succeed,
be refused (a `StepFailure`, stored as a value), or throw a retriable error.
Each step counts its own failures. The holder's heartbeat records the step it is
running on the schedule row, a memo write for that step clears it, and an
expired lease counts against the step the row names ("Retries"). A pass loads
the memo when it claims the run, and `run(step, fn)` writes the memo row after
`fn`, fenced on the lease. The log writes and the node's outcome are store
writes, which commit in their own transactions and are fenced on the lease too
("Fencing store writes").

The log open is an idempotent step that stores no memo row (`runIdempotent`),
and the close is no step at all: both run on every pass, and the pass reads the
node's log row when it claims the run and skips an open of a row that exists
and a close the conditional close would refuse. The open's insert may throw a
retriable error, counted against the open's own step, and a step whose retries
are spent is refused before it runs, which fails the node. A later success over
those failures marks the open's memo row succeeded (`SuccessReconcilesFailures`),
after which a failure of the open is counted by nobody. The open is never the
step the heartbeat records (`IdempotentStepIsNeverRunning`). The read is
load-bearing: with `PassReadsLogRows` off, a pass runs the insert of an open
that already succeeded again, and a failure there is counted by nobody, so the
node can retry its open forever (mutation `pass-reads-no-log-rows`). The read
finds the row by the id `LogIdIsTheStepId` derives and skips only what
`CloseIsConditional` refuses, so the mutations `log-id-random` and
`log-close-unconditional` turn off the half of the read that rests on their
guard, and each still breaks its rule. About 52,000 states.

This is at-least-once by design: a worker whose lease expired mid-step can still
call a vendor once more before its memo write is refused, and a crash or an
expired lease between a store write or a call and its memo row runs it again.
The rules check what the design promises despite that.

| Rule | The promise | The harm when it breaks |
| --- | --- | --- |
| `WriteAppliedOnce` | Vendor B applies the send once, however many times the step runs. | A patient gets the same message twice. |
| `AppliedWriteMatchesTheOutput` | What vendor B applied is the value the node records as its output. | The Runs view shows a value other than the one sent. |
| `RefusalFailsTheNodeOnce` | A refused call is never retried as a transient error, and no lease holder sends again after a refusal is recorded. | A vendor's 400 is sent four more times. |
| `FailedOnlyOnRefusalOrSpentRetries` | The node fails only on a refusal, or after one of its steps spent that step's own retries. | A transient error fails the node, or a step gets only the retries an earlier step left. |
| `OneLogRowPerNode` | The node has one log row, however many passes open it. | The Runs view shows a node twice, and a later node reads the wrong row's output. |
| `LogClosedOnce` | The node's log row is closed once, however many passes close it. | A finished node's output or duration is overwritten. |
| `NodeOutcomeIsFinal` | Once the node has succeeded or failed, nothing rewrites that outcome. | A stale worker turns a succeeded node into a failed one. |
| `FinishedNodeNeverRefused` | Once the node's log row is closed as a success, the node is never failed or refused afterwards, and none of its steps reads as retrying. | The Runs view shows a finished node as retrying, and failures charged to its log open on later passes refuse it and fail the run. |
| `NodeEnds` (liveness) | The node ends. | The run loops on a node forever. |

### `Siblings`: two steps of one pass side by side

One pass runs step A, a vendor call with no idempotency key, beside step B,
which may throw a retriable error once, as the engine runs parallel branches.
A step that throws stops the pass: it starts no other step, and the engine
abandons the branches still running while their step bodies run on. A pass may
instead be interrupted, as a drain or a Worker's budget cut does: it aborts the
signal its step bodies were handed and releases the row, and A's body stops if
it honours the signal and runs on detached if it does not, such as a handler's
plain Promise. A worker may crash, which ends its bodies with it. About 2,000
states.

| Rule | The promise | The harm when it breaks |
| --- | --- | --- |
| `SucceededStepRunsOnce` | A step's vendor call runs again only after an interruption or a crash, never because a sibling step threw. | A Slack message is posted twice because another branch's lookup answered 502. |
| `OneBodyAtATime` | Two bodies of one step never run at once. | A worker that picks the run up calls the vendor beside the step an interrupted pass left running. |
| `NodeEnds` (liveness) | The node ends. | The run loops on the node forever. |

### `Timing`: leases, heartbeats, polling and the Worker driver

A discrete clock. Anything due at the current instant (a poll, a heartbeat, an
expired lease, a platform kill) happens before time advances. One run does a
step, sleeps until its deadline, then does a second step; a step takes one
unit, or four, which outlasts either driver's lease. Two drivers are checked:

- `node`: a long-lived loop polling every unit and heartbeating every unit, with
  a lease of three: the design's one-second poll and 20-second heartbeat over a
  60-second lease.
- `worker`: a Cloudflare Worker invocation started by a one-minute Cron Trigger
  or a queue message, heartbeating every minute, killed at a six-minute budget,
  with a two-minute lease (the design's 5:15 lease-to-budget ratio, scaled). A
  queue message can be delayed at most two minutes, so the run's five-minute
  sleep is woken by the cron sweep. About 3,200 states.

| Rule | The promise | The harm when it breaks |
| --- | --- | --- |
| `NoResumeBeforeTheDeadline` | A Wait never resumes before its deadline. | A reminder goes out early. |
| `DeadlineHonouredOnTime` | A sleeping run is picked up within one poll or cron interval of its deadline, or of the moment it parked if later. | A long sleep on Workers overshoots by the queue's delay cap or never wakes. |
| `LiveLeaseNeverExpires` | A lease never expires under a live worker heartbeating through a step. | A long step is run twice and an attempt is spent. |
| `DeadWorkerRecoveredInTime` | A run whose worker crashed or was killed is picked up again within one lease and one interval. | A run sits stuck behind a dead worker. |
| `EveryRunEndsInTime` | Every run ends before the clock stops. | A step longer than the Worker budget never completes. |

The SQLite driver needs no model of its own. Its one process and one writer,
with every write under `BEGIN IMMEDIATE`, allow a subset of the interleavings the
two-worker models check, and the models already treat each guarded write as
atomic. Its ticker is the `node` driver's poll.

### `Cron`: schedule timers, Publish and pause

Decision 9 in section 12 of the design doc, modelled before any cron code
exists. A schedule's timer is a `kind = 'cron'` row of
`workflow_execution_schedule`, keyed by workflow and schedule, which workers
claim under a lease. A fire is one transaction fenced on the lease: it opens
the run through the admission of a manual start that names no Event, for the
Entity Value `workflow:<id>`, and advances `wake_at` to the first slot after
now. Under first wins a fire while a run is going writes a Refused Start and
still advances; under newest wins it supersedes the run. A row claimed late
fires once, for the most recent slot it missed.

Publish rewrites the timer rows in the transaction that activates the version:
it keeps the row of an unchanged schedule, replaces the row of an edited or
added schedule with a new row due at its first slot after now, and deletes the
row of a removed one. Pause deletes the workflow's timer rows in the
transaction that sets `is_paused`, and resume writes one per published
schedule, due at its first slot after the resume. A timer row therefore exists
exactly while its schedule is published and the workflow is unpaused, and the
lease fence is the one guard that keeps a pass from firing after a Publish, a
pause or an expired lease.

One workflow with two schedules, "a" and "b". The published version starts
with "a" on expression 1, which fires at every instant, and holds no "b";
expression 2 fires at every even instant. One Publish may keep, edit or remove
"a" and add "b". The workflow may be paused and resumed once. A clock of three
units advances whether or not a worker has claimed a due row, which is how a
fire is missed. Both Concurrency modes are checked, with runs reduced to how
many are live for `workflow:<id>`. About 68,000 states.

| Rule | The promise | The harm when it breaks |
| --- | --- | --- |
| `OneFirePerSlot` | Each schedule fires each slot at most once, as a run or a Refused Start, and fires its slots in order. | A 9:00 report is sent twice, or a slot before an edit fires after it. |
| `NoFireWithoutTheLease` | No fire commits from a pass that lost its lease. | A worker whose lease expired fires beside the worker that took the row over. |
| `NoFireWhilePaused` | A fire never opens a run on a paused workflow. | A paused workflow keeps sending its scheduled messages. |
| `NoFireForAnUnpublishedSchedule` | A fire never opens a run for a schedule the published version no longer holds, or holds with another expression. | A schedule removed or edited at Publish fires on its old timing. |
| `TimersMatchThePublishedSchedules` | A timer row exists exactly for each schedule of the published version of an unpaused workflow, written for that schedule's expression. | A published schedule never fires, or a removed one keeps a timer. |
| `FireRunsTheLatestSlot` | A fire runs the most recent slot at or before the moment it commits. | A worker that was down for an hour runs the slot from an hour ago, or every missed slot in turn. |
| `NoFireBeforeTheTimerStarted` | A timer never fires a slot at or before the Publish or resume that wrote it. | Resuming at 9:30 runs the 9:00 slot the pause skipped. |
| `FireRunsThePublishedVersion` | A fire opens its run on the version published when the fire commits. | A scheduled run starts on a version that was replaced while its pass ran. |
| `OneLiveScheduledRun` | Under either Concurrency mode, at most one scheduled run is live for `workflow:<id>`. | A slow run and the next fire overlap. |
| `EveryDueTimerFires` (liveness) | Every timer row that comes due fires, or is deleted. | A schedule stops firing after a Refused Start. |

## Bounds and assumptions

- The bounds above: two workers, two versions and two Migrations, three
  arrivals in `Intake` with the inbox sweep on one of them, one arrival fanned out to two workflows in `Delivery`
  with pages of one row, two arrivals and two payloads in `Arrivals`, a clock
  of twenty units in `Timing`, two schedules, two cron expressions, one
  Publish, one pause and resume, and a clock of three units in `Cron`, a retry
  limit of 2, one fault per behaviour.
- Counters stop one past the retry limit, because nothing compares them further.
- The `CountersBounded` constraints cap observer counters at 2 so a mutated
  model stays finite. In the models as written, every counter stays at most 1
  whenever its rule holds, so the caps cut only states where a rule has already
  broken.
- `Siblings` has two steps, one throw and one fault, and leaves out a live
  worker whose lease expires mid-step, which `Handler` and `Timing` check. A
  step body that ignores an interrupted pass's abort is assumed to end within
  one lease (`LeaseWindowPasses`), which is the bound the release's hold-back
  gives.
- Each guarded write is atomic. That holds in the design because each is one
  SQL statement, or one transaction that locks the schedule row first. The park
  producer's `select ... for update` on the schedule row is what makes a wake
  one step against a release; without it, the producer's conditional update can
  miss a release in flight.
- No model bounds a loop's slots: a due row is claimed at the next poll. The
  worker loop claims runs and deliveries in separate lanes, each with slots of
  its own (`runner.concurrency` and `runner.deliveryConcurrency`), so runs
  holding every run slot never keep a delivery, such as a Cancel, from its
  claim, and deliveries never keep a run from its claim. Within one lane, a
  due row waits for a free slot, which the models do not check.
- `NOTIFY` is not modelled. The design treats it as a latency optimisation and
  relies on the poll for correctness, which is what the models check: a worker
  finds every due row by polling.
- Clock time is abstract in every model except `Timing` and `Cron`. In
  `Timing` a timeout is "the deadline passed", and the model uses the design's
  ratios, not its seconds, and models no retry backoff. In `Cron` the clock
  numbers the slots a schedule fires at.
- `Timing` has one clock that every worker reads. On PostgreSQL that holds for
  leases: every lease instant a worker writes or compares is moved onto the
  database's clock by the worker's measured offset from it, once that offset
  passes one second (`databaseClockOffset` in `repo/schedule.ts`). Wake times
  and park deadlines stay on each worker's own clock, so a skew between
  workers moves a wake by that skew. SQLite has one process and one clock.

## Coverage record

Each guard the design depends on is a named operator in its model, so a reader
can find it and a mutation can remove it.

The last column names the code that implements each model part. Runs and
Event deliveries both execute on the executor, and every part the models cover
runs there, the Timing model's `worker` driver included. A design doc section stays in the middle column where the
code alone does not explain the rule. Paths are under `packages/core/src/backend`, with `repo/` for
`services/executions/repo/`, `sqlite/` for `persistence/sqlite/executions/`,
`executions/` for `services/executions/`, and `lifecycle/` and `migration/` for
the directories of those names under `services/workflows/`.

| Model part | Design doc section | Code |
| --- | --- | --- |
| `DurableExecutor`: `Claim`, `ClaimWhenDue`, `ParkIsDue` | | `claimDue` in `repo/schedule.ts` and `sqlite/schedule.ts`, which leases the due rows of each lane's kind in one statement (`dueSchedule` in `repo/release-policy.ts`), reading on PostgreSQL each row's state and running step from the locking select itself (`lockDueRows`), so the claim counts what the row holds when it is locked, as the model's atomic `Claim` does, and resolves each claimed run's overdue `waiting` parks with `TIMEOUT_WAKE` in the claim's transaction (`resolveOverdueParks`); `claimAttempt` in `repo/release-policy.ts`, which counts nothing for a row a wake or a release queued |
| `LeaseHeldBy`, `Fenced` (all models) | | `holdsLease` and `writeFenced` in `repo/schedule.ts` and `sqlite/schedule.ts`, both standing on `leasedUnderFence` in `repo/release-policy.ts`; `watchPassOnlyWrites`, `watchStoreWrites` and `watchCronWrites` in `executor/runtime.ts`, which stop the pass at the first write the fence refuses with `LeaseLost`, and `watchedSettle` in `executor/delivery-body.ts` for a delivery's settling write |
| `VisitStarted`, `VisitCanceled`, `RunsPast`, `RunsOutlet` | | `waitForEvent` in `executor/runtime.ts`, which answers `{ kind: "woke" }` from the wait row's `wake`, or records the parking step (`recordParkStep`) and answers `{ kind: "parked" }`; `runWaitAttempt` in `engine/wait.ts`, which halts the branch on `parked`; `settle` and `PassParked` in `engine/scheduler.ts` and `endParked` in `engine/core.ts`, the pass's one parked exit; the `openResume` and `createWaitState` fences in `engine/wait.ts`; `startWait` in `repo/waits.ts` |
| `StartedSideAdmits`, `CanceledSideAdmits` | CONTEXT.md "Canceled Branch" | `claimAdmits` in `repo/runs.ts` and `sqlite/runs.ts` |
| `EnterCanceledOutlet` | | the `lifecycle-check` step in `engine/cancel-boundary.ts`; `runCanceledOutlet` in `engine/scheduler.ts` |
| `AdmitJoin`, `ExitBeforeJoin`, `ExitBeforeBranch`, `ClaimIsFree` | CONTEXT.md "Entity Eligibility" | `admitNode` in `engine/scheduler.ts`; `requestExitWrite` in `repo/runs.ts`, which writes a free claim only; the fenced `requestExit` in `repo/fenced-writes.ts` and `sqlite/fenced-writes.ts`, which resolves the run's other `waiting` parks with the `exit` wake in the same transaction (`exitWakeForClaim`, `resolveOpenParks`) |
| `JoinSucceeds`, `JoinFails`, `Release`, `RetriesSpent`, `FailedNodeEndsRun` | "Retries" | `run` in `executor/runtime.ts`, which stops the pass when a step throws, starting no step after it while a step already running still records its value (`Siblings`), and fails a step whose memo row is `failed`; `decideFailedPass` in `executor/pass.ts`; `releasePass` in `repo/schedule.ts` and `sqlite/schedule.ts`, with `countStepFailure` and `decideRelease` in `repo/release-policy.ts`; the terminal status `executeWorkflow` chooses in `engine/core.ts`, written by `endRunWrite` through `endRunsWrite` in `repo/runs.ts`, which decides the status from the claim it reads under its lock with `planRunEnds` and `decideRunEnd` (`@wfgraph/shared/lifecycle/run-ending`), deletes the schedule row and cancels the run's open parks. The model keeps one run counter for the Join's failures and every expired lease, and the code counts each step's failures on its memo row; `Handler` checks the per-step count. The code produces fewer orders than the model: a throwing step ends the pass, so a Canceled outlet's Wait cannot park in the same pass in which an admitted Join throws. It parks on the pass after the Join's node fails, as the case "runs the Canceled outlet and ends canceled when a Join admitted before the Cancel Event spends its retries" in `executor/testing/pass-cases.ts` shows. |
| `ReleaseReadsWaitRows`, `ReleaseReadsWaitRow` | | `releasePass` in `repo/schedule.ts` and `sqlite/schedule.ts`, which locks the schedule row before it reads the run's wait rows; `decideRelease` in `repo/release-policy.ts`, which re-queues a run whose wait row holds a wake no pass consumed |
| `LeaseExpires`, `SweepDeadLease`, `Crash` (all models) | | the expired-lease sweep in `claimDue`, which counts one failure against the step the schedule row records as running (`sweptStepFailures`), or against the run when no step is recorded or the recorded step's memo row has settled (`claimAttempt`); the model's heartbeat names the step its holder runs, and the code's names none while parallel steps run, which the claim then counts against the run; `renewLeaseWhileRunning` in `executor/pass.ts`, which records the running step. `DurableExecutor` and `Migration` count every expired lease against the run. A pass interrupted by its worker's drain releases its row as `interrupted` by `drain` (`releaseInterrupted` in `executor/pass.ts`), queued with nothing counted, due at once when every step body it started stopped and one lease later when one still runs, which `Siblings` checks as `Interrupt`; for the other models a graceful stop behaves as a `Crash` whose lease the claim sweeps at once without counting a failure. A pass a tick's budget cuts releases its row as `interrupted` by `budget`, due by the same rule, with one failure counted against the step it was running (`stepFailureOf` in `repo/release-policy.ts`), which is the expired-lease sweep of that pass with the same count, recovered sooner. |
| `EventWake`, `WakeIsUnclaimed` | "Resolving a park" | `claimWaitState` in `repo/claims.ts` and `claimWait` in `sqlite/claims.ts`, behind `claimWaitingStateById` and `claimWaitingStateByToken` and the driver's `resolvePark` (`executions/driver.ts`): one transaction through `wakeExecutions` (`repo/schedule.ts` and `sqlite/schedule.ts`) that locks the run's schedule row, writes the `resume` wake only onto a row still `waiting` (`claimablePark` in `repo/release-policy.ts`) of a run in flight with no Exit claim, and re-queues a `waiting` schedule row. The `wake` column is the one record of the resume, and its `deliveryId` is how a delivery's retry finds its own claim (`claimedByDelivery` in `repo/release-policy.ts`). `wakePark` in `repo/schedule.ts` and `sqlite/schedule.ts` is the same write by row id on the same helper, which the replay harness's producers call. `wakeExecutions` also pulls a `queued` row's `wake_at` forward to the write's `now`, which no model distinguishes, since only `Timing` has a clock and it models no backoff. |
| `CancelEvent` | "Cancellation" | `requestCancelForEntity` in `repo/claims.ts` and `sqlite/claims.ts`, behind the driver's `requestCanceledOutlet` and `requestCanceledOutlet` in `lifecycle/cancel.ts`: one transaction through `wakeExecutions` that locks the candidates' schedule rows, writes the claim, resolves the claimed runs' `waiting` parks with the `cancel` wake (`resolveOpenParks`) and re-queues them. Every park open when the claim lands is on the Started side. |
| `PolicyCancel`, `RunInFlight` | | `cancelInFlightRuns` in `executions/end-runs.ts`; `cancelRun` in `repo/runs.ts`, whose `endRunsWrite` deletes the schedule row and cancels the run's open parks in the same transaction |
| `Migration`: `Repin`, `RepinNeedsAPark` | "Migration"; ADR-0019; section 11, phase 2 | `repinVersion` in `repo/claims.ts` and `sqlite/claims.ts`, with `matchesClassification` in `repo/release-policy.ts`, which locks the run's schedule row before its execution row and refuses a run that is running or holds a woken Wait; `migrateExecutions` in `migration/migrate.ts` through the driver's `migrateRun`. The `repin-while-running` mutation shows that dropping this guard alone breaks `BelowRunsThePinnedVersion`. |
| `Migration`: `MigrateWake`, `Requeue` | "Migration" | `repinVersion`, which writes the `migrate` wake on every park (`resolveOpenParks`) and re-queues a `waiting` run through `wakeExecutions` in the repin's own transaction: `Repin` followed at once by `MigrateWake`. |
| `Migration`: `Prepare`, `Park`, `StillPinned` | "Migration" | the `createWaitState`, `reparkWaitState` and `markExecutionRunning` fences in `engine/wait.ts`; `readMissedWake` in `engine/wait.ts`, which answers an Event or claim wake from the wait row's `wake` column (`readWaitState` in `engine/db-store.ts`) when a re-park finds the row already woken, the `Park` action's `event` arm after the pass re-prepares under the version it loaded |
| `Migration`: `Release`, `FenceRefusalCountsNoAttempt` | | `versionRefused` in `engine/wait.ts`, which fails with the `version_refused` kind; `decideFailedPass` in `executor/pass.ts`, which releases that failure as `fence_refused`; `decideRelease` in `repo/release-policy.ts`, which re-queues the run after the first retry's backoff, counts nothing and leaves the run's count as it was; the model has no clock, so the backoff, which keeps a refusal that recurs from looping hot, is invisible to it |
| `Intake`: `SendViaApp`, `SendInHostTransaction`, `PollInbox`, `InboxKeyIsUnique` | Section 7.1 and 7.3 | `insertInboxEvent` in `repo/inbox.ts` and `sqlite/inbox.ts`, through `writeArrival` in each, which inserts the inbox row, marked `scheduled_at`, and its `delivery` schedule row in one transaction and writes nothing for a key a `pending` or `delivered` row already holds under the unique index `workflow_event_inbox_idempotency_uidx` (`InboxKeyIsUnique`); a key a `failed` row holds reopens that row as `pending` with a new schedule row (`resendOnHeldKey` in `repo/inbox-policy.ts`), which is `SendViaApp`'s `ResendRedeliversFailed` arm; the host's insert documented at `workflowEventInbox` in `lib/db/schema.ts` (`SendInHostTransaction`); `scheduleUnscheduledInbox`, whose rows `awaitsSchedule` in `repo/inbox-policy.ts` picks: a `pending` row with no `scheduled_at`, which is the model's `dsched = "none"`, since every write of a delivery schedule row marks its inbox row in the same transaction and a settled row leaves `dsched` at `"gone"` with its mark kept; called once per poll by `runWorkerLoop` and once per `tick` (the `poll` of `executorUpkeep` in `executor/upkeep.ts`), which is `PollInbox`. Every source reaches it through the driver's `receiveEvent` (`executions/driver.ts`), which is `SendViaApp`: `sendEvent` (`executions/send-event.ts`), webhook intake (`integrations/webhook-intake.ts`), and the Inngest forwarder (`createInngestEventForwarder` in `lib/inngest/event-forwarder.ts`), which calls `app.events.send` and so reaches `sendEvent` keyed by the Inngest event id. |
| `Intake`: `ClaimDelivery`, `LifecycleStep`, `RecordMemo`, `FinishDelivery` | Section 7.2 | A claim for the `delivery` kind leases them (`dueSchedule` and `claimedSchedule` in `repo/release-policy.ts`), in the worker loop's delivery lane (`lanesFor` in `executor/worker-loop.ts`), and `leasedPass` opens them with `openDeliveryPass` in `executor/pass.ts`, whose writes are fenced on the owner token and the inbox row (`ExecutionRepo.fencedDelivery`). `deliveryBody` in `executor/delivery-body.ts` runs `fanOutDelivery` (`executor/delivery-fanout.ts`) on the pass's step port (`createPassSteps` in `executor/runtime.ts`), then `finishDelivery`; a refused payload, a row naming no Event, or a step past its retries ends in `failDelivery`. A row a forwarder or webhook intake recorded under an umbrella source name is resolved to the Event whose `source.when` accepts its data (`resolveArrival` on the extension set, which the delivery body reads from the `Extensions` service, built by `arrivalResolver` in `extensions/arrival-resolution.ts`, which `sendEvent` also calls); a row no Event on its source accepts is owed nothing and ends in `finishDelivery` (`unmatched_source`). The model has one Event per arrival, so each of its arrivals is a row that resolution has already named. Both, in `repo/inbox.ts` and `sqlite/inbox.ts`, settle the inbox row in one transaction fenced on the owner token (`FinishDelivery`, `FailRecordsTheRow`): `finishDelivery` deletes the schedule row and its step memo, and `failDelivery` keeps the schedule row `settled` with its memo (`settledDeliverySchedule` in `repo/inbox-policy.ts`), which `Intake`'s `dsched = "gone"` covers since no claim or poll takes a settled row. |
| `Delivery`: `FinishFailed`, `Reopen`, `KeepMemoOnReopen` | ADR-0022 | `failDelivery` in `repo/inbox.ts` and `sqlite/inbox.ts`, which keeps the schedule row `settled` with its memo; `requeueDeliverySchedule` in each, which a resend that reopens the failed inbox row (`writeArrival`) uses to queue that row again with no failure counted; `tryStep` in `executor/delivery-fanout.ts`, which answers every try the memo holds and bounds a failed workflow's new tries by the row's own count alone, so the reopened delivery tries it again with a full set of retries. The `reopen-drops-the-memo` mutation shows that deleting the row on failure breaks `NoSecondWaitFromOneArrival`. |
| `Intake`: `StartWrite`, `DeliveryIdIsUnique`, `ExecutionAndScheduleTogether` | Section 7.1; scenario S13 | `answerFromCommittedDecision` in `lifecycle/deliver-event.ts`; `startForEntity` in `repo/index.ts` and `sqlite/executions/index.ts`, behind the driver's `startRun` (`executions/driver.ts`): the transaction that inserts the Execution also inserts its schedule row (`insertRunSchedule`) and its "run started" entry, which is `ExecutionAndScheduleTogether`; a start answered with the row its delivery already committed writes neither again. |
| `Intake`: Concurrency in `StartWrite`, `SupersedeDropsSchedule` | CONTEXT.md "Concurrency", "Superseded" | `startWithConcurrency` in `lifecycle/concurrency.ts`; `admitWithConcurrency` in `repo/admission.ts` and `sqlite/admission.ts`, which ends each displaced run through `endRunsWrite`, deleting its schedule row in the transaction that opens the newer run |
| `Intake`: `CancelComparesArrivals`, `StartReadsCancelDecisions`, `Receive` | CONTEXT.md "Cancel Event"; ADR-0022 | `startedNoLaterThan` and `cancelReceivedNoEarlier` in `repo/cancel-order-policy.ts`; the claim in `requestCancelForEntity` (`repo/claims.ts`, `sqlite/claims.ts`), which passes over a run whose start's inbox row was received after its own; `claimForCancelDeliveredFirst` in `repo/cancel-order.ts` and `sqlite/cancel-order.ts`, which `openRun` in `repo/admission.ts` and `sqlite/admission.ts` runs in the transaction that opens a run; `lockCancelScope` and `lockEventStart` in `repo/cancel-order.ts`, the PostgreSQL Entity locks that make each side one step; the inbox row's `received_at`, which `Receive` orders. The `cancel-ignores-arrival-order` and `start-ignores-cancel-decisions` mutations show each guard is needed. |
| `Intake`: `CancelWrite`, `CancelDecisionIsRecorded` | "Cancellation" | `requestCancelForEntity` in `repo/claims.ts` and `sqlite/claims.ts`, which records the arrival's delivery id in `cancel_delivery_id`, its decision as a `workflow_cancel_decisions` row in the same transaction whether or not it flagged a run, and each flagged run's `run_cancel_requested` entry; a retry that finds the decision flags nothing new (`cancelClaimable` and `claimedEarlierBy` in `repo/release-policy.ts`) |
| `Migration`: `EventWakeNeedsAnEventPark`, `EventReplacesMigrateWake` | "Resolving a park"; "Migration"; ADR-0019 | the `wait_type = 'event'` condition `claimWaitingStateByToken` and `claimWaitingStateById` pass to `claimWaitState`, in `repo/claims.ts` and `sqlite/claims.ts`; `claimablePark` in `repo/release-policy.ts`, which also takes a `resuming` row whose wake is `migrate` and replaces that wake with the Event's. |
| `Migration`: `ReparkMode` | "Migration"; ADR-0019 | `reparkWaitWrite` in `repo/waits.ts` and `sqlite/waits.ts`, which the fenced `reparkWait` runs |
| `Delivery`: `Lifecycle`, `Life1`, `Life2`, `Settled` | Section 7.2; CONTEXT.md "Precedence" | `fanOutDelivery` and `settledExecutionIds` in `executor/delivery-fanout.ts`; `applyLifecycleRules` in `lifecycle/deliver-event.ts`. The model commits a lifecycle step's write and its memo row together, and the code commits them apart, so a re-run step answers what its first attempt committed: a start through `answerFromCommittedDecision`, and a Cancel through its `workflow_cancel_decisions` row, which makes the retry flag nothing new and answer the `claimed_earlier` runs `requestCancelForEntity` finds by `cancel_delivery_id` (`canceledOutletClaims` in `repo/release-policy.ts`), which keeps `Settled` whole across a crash between the two. |
| `Delivery`: `ScanAllPages`, `Candidate`, `ExcludeSettledRuns`, `SavePagesBeforeWaking` | Section 7.2 | `listWaitCandidatePage` in `lifecycle/deliver-event.ts`; `listWaitsForEvent` in `repo/waits.ts` |
| `Delivery`: `WakeSavedPage`, `RecordWokenPage`, `WakeIsUnclaimed` | Section 7.2; "The runtime", `run(step, fn)` | `deliverWaitCandidates` in `lifecycle/deliver-event.ts`; `resumeWaitsMatchingEvent` in `lifecycle/resume-waits.ts`; `claimWaitingStateById` in `repo/claims.ts` |
| `Intake`: `StartWrite` admission arm, `RefusalIsConsulted`, `EligibilityBeforeConcurrency` | CONTEXT.md "Entity Eligibility", "Precedence" | `answerFromCommittedDecision` in `lifecycle/deliver-event.ts`; `recordStartRefusal` and `startAdmissionDecisionId` in `executions/run-rows.ts`. `findAdmissionRefusal` (`repo/index.ts`) reads back an Entity Eligibility refusal alone, so a retry of an arrival first wins refused asks Concurrency again (`refused` is `"concurrency"`, which no retry reads). |
| `Intake`: `SweepInbox` | Section 12, decision 7 | `sweepSettledInbox` in `repo/inbox.ts` and `sqlite/inbox.ts`, on `sweepableInbox` in `repo/inbox-policy.ts`, which takes `delivered` and `failed` rows alone; run by `executorUpkeep` in `executor/upkeep.ts` from the worker loop and from `tick`. A send whose key a swept row held inserts a new row under a new id (`generateId` in `insertInboxEvent`), which `NewRow` models. |
| `Intake`: `SweepRun`, `RunSweepKeepsInboxRuns`, and `StartWrite` finding no swept run | Section 12, decision 8 | `sweepEndedExecutions` in `repo/retention.ts` and `sqlite/retention.ts`, on `sweepableExecution` in `repo/retention-policy.ts`: a terminal run that completed before the window and whose inbox row (`delivery_id`) is gone. Both backends delete through `deleteOldestBatch` (`lib/db/batched-delete.ts` and `persistence/sqlite/batched-delete.ts`), a batch at a time; `executorUpkeep` runs it after the inbox sweep. A swept run is one `findByDelivery` (`repo/runs.ts`) no longer finds. |
| `Intake`: `SweepRefusal`, `AuditSweepKeepsInboxRefusals` | Section 12, decision 8 | `sweepWorkflowAuditEvents` in `repo/retention.ts` and `sqlite/retention.ts`, on `sweepableWorkflowAudit` in `repo/retention-policy.ts`: an audit row naming no Execution whose metadata `deliveryId` names no inbox row. The Entity admission refusal `findAdmissionRefusal` reads (`repo/index.ts`) is one such row. |
| `Arrivals`: `OfferOne`, `CanClaim`, `ClaimNeedsTheToken`, `RowIsWaiting` | "Resolving a park"; section 7.2 | `resumeOneWait` in `lifecycle/resume-waits.ts`; `claimWaitingStateById` in `repo/claims.ts` |
| `Arrivals`: the refresh branch of `OfferOne`, `RefreshOnRotatedToken` | ADR-0019 | `canRefreshWaitCandidate` in `lifecycle/resume-waits.ts` |
| `Arrivals`: `Scan`, `Record` | Section 7.2 | `listWaitCandidatePage` and `deliverWaitCandidates` in `lifecycle/deliver-event.ts` |
| `Handler`: `Read`, `Send`, `ReadMemo`, `SendMemo`, `ReadIsMemoized`, `RefusalIsAValue` | ADR-0009 | `run` in `executor/runtime.ts`, which answers a `succeeded` memo row with its value, and otherwise runs the step and records its value through `writeStepMemo` in `repo/schedule.ts` and `sqlite/schedule.ts`, fenced on the lease; `StepFailure` and `RememberedStep` in `extensions/steps/define-step.ts`. A step whose value's JSON is larger than the pass's `maxStepValueBytes` fails with `StepValueTooLarge` before its memo write, and the release marks its memo row `failed` at once (`countStepFailure` with `retriable` false), so the node fails once as a refusal does; the model has no such outcome and checks it only as `refused` |
| `Handler`: `SendCarriesAKey` | ADR-0009 | the idempotency key `callExternal` passes, in `extensions/steps/external-http.ts` |
| `Handler`: `Open`, `OpenSucceeded`, `Close`, `LogIdIsTheStepId`, `CloseIsConditional`, `PassReadsLogRows`, `SuccessReconcilesFailures` | | `nodeLogId`, `openNodeLogWrite` and `closeNodeLogWrite` in `repo/node-logs.ts`, and their twins in `sqlite/logs.ts`: the row id derives from the execution and node ids, the insert keeps the first row, and every close, fenced or not, applies to a row still `running`, or to an `error` row when it reports `success` (`nodeLogCloseGuard` in `repo/node-log-close.ts`, a WHERE condition). The `node:<n>:log-open` step in `engine/step-log.ts`, and the Wait's open in `engine/wait.ts`, run through `runIdempotent` in `executor/runtime.ts`, which refuses a step whose memo row is `failed`, counts a failure the step throws against its id, and on a success over a `failing` row writes the row `succeeded` through `writeStepMemo`. The close is `closeStepLogQuietly` in `engine/step-log.ts`, a store write that counts no failure. `runBody` in `executor/run-body.ts` reads the run's log rows through `listNodeLogStates` when the pass opens, and `startStepLog` and `completeStepLog` in `engine/db-store.ts` skip what the model's `seenOpen` and `seenClose` skip (`nodeLogCloseApplies` in `repo/node-log-close.ts`). The model has no `error` close, so it does not check a retry that corrects a row closed as `error`, and its open and reconciling write are one action where the code makes two writes. |
| `Handler`: `StoreWriteIsFenced`, `MayWrite`, `Outcome`, `Release` | | `makeFencedWrites` in `repo/fenced-writes.ts` and `makeSqliteFencedWrites` in `sqlite/fenced-writes.ts`, held to the fence's run by `guardStoreWrites` in `repo/fencing.ts`; `watchStoreWrites` in `executor/runtime.ts`, through which `createDbWorkflowStore` (`engine/db-store.ts`) writes on a pass (`executor/run-body.ts`); `releasePass` in `repo/schedule.ts`; `endRunWrite` in `repo/runs.ts`. The pass that wrote the terminal record makes its remaining store writes unfenced (the `ended` phase in `executor/runtime.ts`); no model has a write after the terminal record. |
| `Handler`: `AttemptsArePerStep`, `FailingStep`, `RetriesSpent`, `Settled`, `RunningStepOf`, `Heartbeat`, `IdempotentStepIsNeverRunning`, `LeaseExpires`, `SweepDeadLease` | "Retries"; "Lease and liveness" | `countStepFailure` and `STEP_RETRY_LIMIT` in `repo/release-policy.ts`, which count a step's failures on its memo row and leave a `succeeded` row alone; `sweptStepFailures` in `repo/release-policy.ts` and the running step `renewLeaseWhileRunning` records in `executor/pass.ts`, read from `PassState.heartbeatStep`, which names a step `run` reports only while it is the one running and never a `runIdempotent` step, and written through `runningOnRenew` in `repo/release-policy.ts`, which names no step whose memo row has settled, so a heartbeat that loses the race with its step's memo write names nothing; `runningAfterMemo` in `repo/release-policy.ts`, which a memo write uses to clear the running step it names. The run's own count, for a failure no step owns, is not modelled: `claimAttempt` and `retriesSpent` in `repo/release-policy.ts` end such a run `failed` past the limit, which takes more faults than any model allows. |
| `Timing`: `NodeLease`, `NodeHeartbeat`, `NodePoll`, `Expire`, `SweepLateness` | "Wake latency" | `DEFAULT_LEASE_MS`, `DEFAULT_HEARTBEAT_MS` and the `pollMs` option of `runWorkerLoop` in `executor/worker-loop.ts`; `renewLeaseWhileRunning` in `executor/pass.ts`; the expired-lease sweep in `claimDue`. The loop also claims at a released run's own `wake_at` and on a same-process wake (`createWorkerWake`), both sooner than the poll the model bounds, and on a run another process's producer announced through the PostgreSQL backend's `NOTIFY` broadcast (`makeExecutionDriverLayer` in `executions/driver.ts`). |
| `Timing`: `WorkerLease`, `WorkerCron`, `WorkerBudget`, `QueueMaxDelay`, `Kill`, `WorkerUsesCron` | Section 8, "Cloudflare Worker over Hyperdrive" | `WORKER_LEASE_MS` (5 minutes), `WORKER_HEARTBEAT_MS` (1 minute), `WORKER_TICK_BUDGET_MS` (14 minutes) and `WORKER_TICK_CLAIM_WINDOW_MS` (10 minutes) in `worker.ts`, whose `scheduled` handler is the host's one-minute Cron Trigger (`WorkerCron`, `WorkerUsesCron`) and whose `queue` handler is the Queue consumer; `tick` in `executor/worker-loop.ts`, which cuts a pass still running at the budget, releasing its row due at once, or one lease later when a step body ignores the stop, with one failure counted against its running step, as the model's `Kill` followed by the lease sweep counts it. `Kill` is the platform ending the invocation at its 15-minute wall time, which the lease recovers; the model's `WorkerBudget` is that wall time, so the code's 5-minute lease over 15 minutes is the model's 2:6 ratio unscaled, and the tick's own 14-minute budget cuts its passes before the kill. The tick's pass limit (`WORKER_TICK_PASS_LIMIT`), which bounds its CPU time, ends a tick early, which the model's next cron or queue invocation covers. A wake message names no row and carries no delay (`createQueueWake` in `executor/queue-wake.ts`), so every deadline is the cron's, which is the model's `QueueMaxDelay` arm with the sleep longer than the cap. |
| `Siblings`: `StartA`, `StartB`, `BThrows`, `MemoA`, `AdmitRunningStepWrites` | ADR-0009 | `createPassState` and `writeRule` in `executor/runtime.ts`: after `step_threw` a pass starts no step, renews its lease, and accepts the memo write of a step still running (`isRunning`) and a store write made inside one, which the durable bridge names with `CurrentDurableStep` (`engine/durable.ts`); every other write is refused with `LeaseLost`. |
| `Siblings`: `BodyEnds`, `Release`, `ReleaseWaitsForSteps` | | `settlePass` in `executor/pass.ts`, which waits on `PassState.stepsSettled` inside the body's scope, with the heartbeat still running, before it writes the release |
| `Siblings`: `Interrupt`, `DelayWhileStepsRun`, `LeaseWindowPasses` | | `stopRunningSteps` in `executor/pass.ts`, a finalizer of the body's scope that aborts `PassState.signal` and waits `INTERRUPTED_STEP_WAIT_MS` for the step bodies; the signal reaches a step's Effect through `fn(signal)` on `WorkflowExecutionRuntime.run` (`engine/runtime.ts`), `crossInto` in `engine/durable.ts` and `nodeStepApi` in `extensions/steps/define-step.ts`; `releaseInterrupted` sets `wakeAfterMs` to the lease when a body still runs, which `decideRelease` in `repo/release-policy.ts` writes as the row's `wake_at` |
| `Timing`: `ClaimWaitsForTheDeadline` | | the `wake_at <= now` condition on `queued` and `waiting` rows in `claimDue` |
| `Cron`: `Claim`, `ClaimWhenDue` | Section 12, decision 9; section 11, phase 6 | The `cron` member of the claimed-schedule union (`ClaimedCron` in `repo/contracts.ts`, read by `claimedSchedule` in `repo/release-policy.ts`), with an entry in `PASS_KINDS` (`executor/pass.ts`) and a lane of its own in the worker loop (`LANE_ORDER` in `executor/worker-loop.ts`, one slot from `CRON_CONCURRENCY` in `executor/in-process-runner.ts`), claimed by `claimDue` under the same `wake_at <= now` condition (`dueSchedule` in `repo/release-policy.ts`). The row names its workflow, expression and zone in `workflow_id`, `cron` and `time_zone`, unique together, and `leasedUnderFence` holds a fenced write to the row's workflow. A Worker's Cron Trigger tick claims it through the same lanes (`tick` in `executor/worker-loop.ts`). |
| `Cron`: `Fire`, `FiredSlot`, `NextWake`, `FireAndAdvanceTogether`, `RefusalStillAdvances`, `FireReadsThePublishedVersion`, `RefusedStart` | Section 12, decision 9 | `fireCronTimer` in `repo/cron.ts` and `sqlite/cron.ts`, one transaction fenced on the owner token (`writeFencedSerializable` on PostgreSQL, `writeFenced` on SQLite), reached from the pass body `cronBody` (`executor/cron-body.ts`) through `fireSchedule` (`lifecycle/scheduled-start.ts`) and `ExecutionDriver.fireCronTimer`, which commits it through the pass's own `CronPassWrites` (`fencedCron`, watched by `watchCronWrites` in `executor/runtime.ts`), so a refused fence stops the pass as every other fenced write does. It reads the workflow row without locking it and fires only while the workflow publishes the version and the Published mode the preflight checked (`cronFireVerdict` in `repo/cron-policy.ts`). It admits the run through `admitWithConcurrency` (`repo/admission.ts`, `sqlite/admission.ts`), the body `startForEntity` runs once no Entity admission decision answers, for the Entity Value `workflow:<id>`, with `scheduled_for` set to the slot, writes the Refused Start in the same transaction under first wins, and sets `wake_at` to the next wake, releasing the lease, whether the start opened a run or was refused. `fireSchedule` reads its clock once per attempt and computes both before the transaction (`slotTimesAt` in `lifecycle/scheduled-start.ts`): the slot is the latest at or before that clock (`latestSlotAtOrBefore`, `FiredSlot`), and the next wake is `cronWakeAfter` in `repo/cron-policy.ts` (`NextWake`, `StartWake`), croner's first fire strictly after it (`nextFireAfter` in `@wfgraph/shared/lifecycle/cron-schedule`). |
| `Cron`: `Publish`, `Republished`, `RemovedTimerIsDeleted`, `EditClearsTheLease`, `StartWake` | Section 12, decision 9 | `replaceCronTimers` in `repo/cron.ts` and `sqlite/cron.ts`, called by `activatePublishedVersion` in `services/workflows/repo.ts` and by `insertPublishedVersion` in `persistence/sqlite/workflows.ts`, in the transaction that writes the event subscription index. `cronTimerChanges` (`repo/cron-policy.ts`) keeps the row of an unchanged schedule, lease and all, deletes the row of a removed or edited one, and inserts a row with no owner token for an edited or added one. A paused workflow is passed no schedules (`timerSchedules`). On PostgreSQL a kept row is rewritten with its own `wake_at`, so a serializable fire whose snapshot predates the Publish fails with 40001 and retries, and the fire reads the version published when it commits (`FireReadsThePublishedVersion`). |
| `Cron`: `Pause`, `Resume`, `PauseDeletesTimers` | Section 12, decision 9 | `setPaused` in `services/workflows/repo.ts` and `persistence/sqlite/workflows.ts`, reached through `setPausedState` in `services/workflows/bulk-actions.ts`, deletes the workflow's cron rows (`deleteCronTimers`) when it pauses, and when it resumes calls `replaceCronTimers` with the published version's schedules (`timerSchedules` in `repo/cron-policy.ts`), each due at `cronWakeAfter` the resume, in the transaction that sets `is_paused`. |

Last confirmed against: the design doc and the code at `b014dc55`
(`feat/durable-executor`), the migration as it merges: runs and deliveries on
the executor, the delivery lane and one claim for both lanes, the inbox
retention sweep, Inngest only in `@wfgraph/core/inngest`, and the Worker's
tick driver with its budget cut, for every model. Two behaviours of the
code have no model counterpart: a producer pulling a `queued` row's `wake_at`
forward to now (only `Timing` has a clock, and it models no backoff), and a
pass interrupted by dispose's drain releasing its row with nothing counted
(only `Siblings` has a graceful stop; elsewhere it acts as a crash whose lease
is swept at once). Move these commits
forward only after you have read the covered sections and files at the new
commit and confirmed that the models still describe them.

The retention sweeps in `Intake` (`SweepInbox`, `SweepRun`, `SweepRefusal`)
were confirmed against decisions 7 and 8 and the retention code at `065ccf33`.

`Cron` was written against decision 9 of the design doc at `065ccf33`, before
any cron code existed, and its rows above now name the code that landed. The
code adds five steps the model leaves out, none of which a rule depends on:

- A fire also deletes a timer whose workflow is paused or unpublished, or
  whose published version no longer declares the schedule (`dropped` in
  `cronFireVerdict`). The model's lease fence already refuses such a pass,
  because pause and Publish delete or replace the row, so the branch is
  defensive.
- The preflight runs before the fire's transaction, which confirms the
  version and the Published mode it checked are still current. A fire that
  finds them moved writes nothing (`stale`), and `fireSchedule` checks the
  version now published and fires again, so the run still pins the version
  published when the fire commits.
- A slot whose published graph the preflight refuses, or a pass whose
  retries are spent, moves the timer on without firing (`skipCronSlot`),
  as a Refused Start advances it, writes a Refused Start for the slot in the
  same fenced transaction, and records the reason in `last_error`. A skip
  for a refused graph first checks, in that transaction, that the workflow
  still publishes the version and mode the preflight checked
  (`cronPublicationVerdict` in `repo/cron-policy.ts`), and answers `stale` or
  `dropped` as a fire does, so a Publish that repaired the graph gets the
  slot fired. The model has no graph that cannot run.
- A cron pass renews no lease, so no heartbeat races the fire's own release
  of it.
- PostgreSQL's `deleteById` locks the workflow row and then its timers
  before it deletes the workflow, in the order Publish and pause take them.

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

Four earlier findings are fixed in the design doc, and a mutation puts each
back to show the rule still catches it:

- `DurableExecutor` `FailedOnlyAfterRetriesSpent`: the claim counted an attempt
  each time a wake re-queued the run, so waking a Wait spent a retry. Fixed at
  `de79dec4`. Mutation: `claim-counts-an-attempt`.
- `DurableExecutor` `NoWaitLeftOpenAfterTheRunEnds` and
  `CancelClaimRunsItsOutlet`: a Join admitted before a Cancel Event failed on its
  last retry after the outlet's Wait had parked, and the release ended the run
  `failed`, so the Outlet never ran. Fixed at `a7900a58`: a step whose retries
  run out fails its node, and the run goes on to its outlet. Mutation:
  `failed-node-ends-the-run`.
- `Migration` `FailedOnlyAfterRetriesSpent`: a refused version fence counted as
  a retry, so a Migration landing during a pass, after one expired lease, marked
  the run failed with no step having failed. Fixed at `aa34a2dc`: a refused
  fence re-queues the run with the attempt counter unchanged. Mutation:
  `fence-refusal-counts-an-attempt`.
- `Handler` `NodeOutcomeIsFinal`, `FailedOnlyOnRefusalOrSpentRetries` and
  `OneLogRowPerNode`: the design fenced only the memo write, while the models
  fenced every write. A stale worker's store write could rewrite a node's
  outcome or fail a node the live worker would retry, and a lease expiry
  between a log insert and its memo row left two log rows. Fixed at
  `4eab3b43`: every store write is fenced, and each one a re-run step repeats
  is idempotent. Mutations: `store-write-not-fenced`, `log-id-random`,
  `log-close-unconditional`.

## Not covered

- A Wait's Connection filter. `Arrivals` checks the match expression; a
  Connection filter is a further condition of the same kind.
- More than one Execution inside the run model. Concurrency is checked in
  `Intake`, with each run reduced to one step.
- A delivery's retry count. `Intake` lets a delivery fail for good at most once per row and records it (`FailDelivery`); how many retries come first is the Handler model's per-step count.
- A send after the inbox sweep deleted its key's row. It is a new arrival under
  a new id by design (ADR-0022), and `Intake` sweeps only the row of the Start
  it sends once, so it never makes one. The inbox sweep of a Cancel arrival's
  row, which takes its `workflow_cancel_decisions` row by cascade, is left out
  for the same reason.
- The draft snapshot sweep (`sweepUnreferencedDraftSnapshots`), which no rule
  about a run's admission reads.
- Retry backoff timing, `NOTIFY` latency, database failover, and real clock
  values. `Timing` checks the design's ratios.
- Lock order and deadlock. Every model treats a guarded write as one atomic
  step, so a deadlock PostgreSQL aborts with 40P01 is outside them. For cron,
  a fire takes the cron row's lock first, as its fence, while Publish and
  pause lock the workflow row before the cron rows. The fire reads the
  workflow row without locking it, and the key-share lock its run's insert
  takes on that row does not wait for Publish's or pause's update, which
  changes no key. `deleteById` locks the workflow row `for no key update` and
  then the timers, which is the lock order the header of `repo/cron.ts` states
  for every write that touches a timer.
- A cron expression's time zone, and the local times daylight saving skips or
  repeats. Each is a property of `nextFireAfter` and `latestSlotAtOrBefore`
  (`@wfgraph/shared/lifecycle/cron-schedule`), pure functions over croner,
  which `Cron` replaces with two expressions on an integer clock.
- The fire's clock. `Cron` treats a fire as one atomic step at the current
  instant, while `fireSchedule` reads `now` once, before the fire's
  transaction, and computes the slot and the next wake from it. The cron
  body holds that clock to no earlier than the slot the timer was claimed at
  (`fireClock` in `executor/cron-body.ts`), so a worker whose clock stepped
  back cannot read a slot that already fired. A fire whose
  transaction waits across a slot boundary therefore fires the earlier slot,
  and the next pass finds the timer due and fires the later one at once. Two
  distinct slots fire, and no slot fires twice, so the consequence is benign.
- Deleting a workflow, which deletes its cron rows by cascade and fences a pass
  holding one as a pause does, and manual starts sharing the Entity Value
  `workflow:<id>` with scheduled runs.
