-------------------------------- MODULE Cron --------------------------------
(***************************************************************************)
(* Cron schedules, decision 9 in section 12 of                             *)
(* docs/internal/plans/separate-event-intake-from-durable-execution.md.    *)
(*                                                                         *)
(* One workflow whose published version holds up to two schedules, "a"     *)
(* and "b". Each schedule's timer is a kind = 'cron' row of                *)
(* workflow_execution_schedule keyed by workflow and schedule, which       *)
(* workers claim under a lease like any schedule row. The lease holder is  *)
(* the fencing token, as owner_token is: a row the lease sweep, a Publish  *)
(* or a pause has rewritten or deleted no longer names the pass that       *)
(* claimed it.                                                             *)
(*                                                                         *)
(* A fire is one transaction fenced on the pass's lease. It opens the run  *)
(* through the admission of a manual start that names no Event, for the   *)
(* Entity Value workflow:<id>, and advances the row's wake_at to the first *)
(* slot after now. Under first wins a fire while a run is going writes a   *)
(* Refused Start and still advances; under newest wins it supersedes the   *)
(* run. A row claimed late fires once, for the most recent slot it missed. *)
(*                                                                         *)
(* Publish rewrites the timers in the transaction that activates the       *)
(* version: it keeps the row of an unchanged schedule, replaces the row of *)
(* an edited or added one with a new row due at its first slot after now,  *)
(* and deletes the row of a removed one. Pause deletes every timer row of  *)
(* the workflow, and resume writes one per published schedule, due at its  *)
(* first slot after the resume. So a timer row exists exactly while its    *)
(* schedule is published and the workflow is unpaused, and the lease fence *)
(* alone keeps a pass from firing after any of those changes.              *)
(*                                                                         *)
(* The clock is a small integer. Expression 1 fires at every instant and   *)
(* expression 2 at every even instant, so an edit changes a schedule's     *)
(* slots. Time may pass while no worker claims a due row, which is how a   *)
(* fire is missed. The published version starts with "a" on expression 1  *)
(* and no "b", so one Publish can keep, edit or remove "a" and add "b".    *)
(* Runs are reduced to how many are live for the Entity; Intake checks     *)
(* Concurrency in depth.                                                   *)
(***************************************************************************)
EXTENDS Integers

CONSTANTS Workers, MaxTime, MaxFaults, MaxPublishes, MaxToggles

Schedules == {"a", "b"}
Exprs     == {1, 2}           \* a schedule's cron expression; 0 stands for none

\* cronWakeAfter: the first slot of expression e strictly after time t.
NextAfter(e, t) == IF e = 1 THEN t + 1 ELSE t + 2 - (t % 2)
\* cronSlotAt: the most recent slot of expression e at or before time t.
LatestSlot(e, t) == IF e = 1 THEN t ELSE t - (t % 2)

VARIABLES
  now,          \* the clock
  mode,         \* the workflow's Concurrency: "newest" | "first"
  version,      \* the published version's number
  pubExpr,      \* each schedule's expression in the published version, 0 when it holds none
  paused,       \* workflows.is_paused
  toggles,      \* pauses and resumes so far
  row,          \* each schedule's timer row: "none" | "waiting" | "leased"
  rowExpr,      \* the expression the timer row was written for, 0 with no row
  wakeAt,       \* the timer row's wake_at
  holder,       \* the timer row's owner_token: the worker holding the lease, 0 for none
  timerFrom,    \* when a Publish or a resume wrote the timer row
  pc,           \* each worker: "idle" | "fire" | "advance"
  cur,          \* each worker: the schedule whose row its pass holds
  claimedExpr,  \* each worker: the expression its pass loaded with the row
  loaded,       \* each worker: the published version when its pass claimed the row
  live,         \* runs live for the Entity workflow:<id>
  faults,       \* crashes and expired leases so far
  lastSlot,     \* each schedule: the slot it fired last, -1 for none
  \* Observers, each set by a fire that breaks one rule: dupFire breaks
  \* OneFirePerSlot, staleFire NoFireWithoutTheLease, pausedFire NoFireWhilePaused,
  \* unpublishedFire NoFireForAnUnpublishedSchedule, notLatest FireRunsTheLatestSlot,
  \* earlyFire NoFireBeforeTheTimerStarted, wrongVersion FireRunsThePublishedVersion.
  dupFire, staleFire, pausedFire, unpublishedFire, notLatest, earlyFire, wrongVersion

wfVars     == <<mode, version, pubExpr, paused, toggles>>
timerVars  == <<row, rowExpr, wakeAt, holder, timerFrom>>
workerVars == <<pc, cur, claimedExpr, loaded>>
observers  == <<dupFire, staleFire, pausedFire, unpublishedFire, notLatest, earlyFire, wrongVersion>>
vars == <<now, wfVars, timerVars, workerVars, live, faults, lastSlot, observers>>

\* The guards the design depends on.
LeaseHeldBy(w) == holder[cur[w]] = w           \* the fire's write checks owner_token
ClaimWhenDue(s) == wakeAt[s] <= now            \* the claim's `wake_at <= now`
FireAndAdvanceTogether == TRUE                 \* the run and the new wake_at commit in one transaction
RefusalStillAdvances == TRUE                   \* a Refused Start advances wake_at like an opened run
FireReadsThePublishedVersion == TRUE           \* the fire reads the published version in its transaction
RemovedTimerIsDeleted == TRUE                  \* Publish deletes the row of a removed schedule
EditClearsTheLease == TRUE                     \* Publish replaces an edited schedule's row, owner_token and all
PauseDeletesTimers == TRUE                     \* pause deletes the workflow's timer rows
RefusedStart == mode = "first" /\ live > 0     \* first wins: a run for the Entity is going
StartWake(e) == NextAfter(e, now)              \* a new or resumed timer's first wake: after now

\* The slot a fire runs, and the wake it advances to.
FiredSlot(w) == LatestSlot(claimedExpr[w], now)
NextWake(w) == NextAfter(claimedExpr[w], now)

\* The run's version: the published version when the fire commits.
RunVersion(w) == IF FireReadsThePublishedVersion THEN version ELSE loaded[w]

Init ==
  /\ now = 0 /\ mode \in {"newest", "first"} /\ version = 1
  /\ pubExpr = [s \in Schedules |-> IF s = "a" THEN 1 ELSE 0] /\ paused = FALSE /\ toggles = 0
  /\ row = [s \in Schedules |-> IF s = "a" THEN "waiting" ELSE "none"]
  /\ rowExpr = pubExpr
  /\ wakeAt = [s \in Schedules |-> IF s = "a" THEN NextAfter(1, 0) ELSE 0]
  /\ holder = [s \in Schedules |-> 0] /\ timerFrom = [s \in Schedules |-> 0]
  /\ pc = [w \in Workers |-> "idle"] /\ cur = [w \in Workers |-> "a"]
  /\ claimedExpr = [w \in Workers |-> 1] /\ loaded = [w \in Workers |-> 1]
  /\ live = 0 /\ faults = 0 /\ lastSlot = [s \in Schedules |-> -1]
  /\ dupFire = FALSE /\ staleFire = FALSE /\ pausedFire = FALSE /\ unpublishedFire = FALSE
  /\ notLatest = FALSE /\ earlyFire = FALSE /\ wrongVersion = FALSE

\* A worker's pass ends; its pass state is cleared so idle workers compare equal.
GoIdle(w) ==
  /\ pc' = [pc EXCEPT ![w] = "idle"] /\ cur' = [cur EXCEPT ![w] = "a"]
  /\ claimedExpr' = [claimedExpr EXCEPT ![w] = 1] /\ loaded' = [loaded EXCEPT ![w] = 1]

-----------------------------------------------------------------------------
(* The timer's pass. *)

Claim(w, s) ==
  /\ pc[w] = "idle" /\ row[s] = "waiting" /\ ClaimWhenDue(s)
  /\ row' = [row EXCEPT ![s] = "leased"] /\ holder' = [holder EXCEPT ![s] = w]
  /\ pc' = [pc EXCEPT ![w] = "fire"] /\ cur' = [cur EXCEPT ![w] = s]
  /\ claimedExpr' = [claimedExpr EXCEPT ![w] = rowExpr[s]]
  /\ loaded' = [loaded EXCEPT ![w] = version]
  /\ UNCHANGED <<now, wfVars, rowExpr, wakeAt, timerFrom, live, faults, lastSlot, observers>>

\* The fenced UPDATE of the timer row: it releases the lease, and it changes
\* nothing on a row a pause or a Publish deleted.
ReleaseRow(s) ==
  /\ row' = [row EXCEPT ![s] = IF @ = "none" THEN "none" ELSE "waiting"]
  /\ holder' = [holder EXCEPT ![s] = 0]

\* fireCronTimer: under the lease, open the run through the manual-start
\* admission and advance wake_at, in one transaction.
Fire(w) ==
  /\ pc[w] = "fire" /\ LeaseHeldBy(w)
  /\ LET s == cur[w]
         slot == FiredSlot(w)
     IN
     /\ lastSlot' = [lastSlot EXCEPT ![s] = slot]
     /\ dupFire' = (dupFire \/ slot <= lastSlot[s])
     /\ staleFire' = (staleFire \/ holder[s] # w)
     /\ pausedFire' = (pausedFire \/ paused)
     /\ unpublishedFire' = (unpublishedFire \/ pubExpr[s] # claimedExpr[w])
     /\ notLatest' = (notLatest \/ slot # LatestSlot(claimedExpr[w], now))
     /\ earlyFire' = (earlyFire \/ slot <= timerFrom[s])
     /\ wrongVersion' = (wrongVersion \/ (~RefusedStart /\ RunVersion(w) # version))
     \* startWithConcurrency: a Refused Start, or the run, superseding under newest wins.
     /\ live' = IF RefusedStart THEN live ELSE IF mode = "newest" THEN 1 ELSE live + 1
     /\ IF FireAndAdvanceTogether
          THEN /\ wakeAt' = [wakeAt EXCEPT ![s] =
                              IF RefusedStart /\ ~RefusalStillAdvances THEN @ ELSE NextWake(w)]
               /\ ReleaseRow(s) /\ GoIdle(w)
          ELSE /\ pc' = [pc EXCEPT ![w] = "advance"]
               /\ UNCHANGED <<wakeAt, row, holder, cur, claimedExpr, loaded>>
  /\ UNCHANGED <<now, wfVars, rowExpr, timerFrom, faults>>

\* The second transaction of a fire split in two.
Advance(w) ==
  /\ pc[w] = "advance" /\ LeaseHeldBy(w)
  /\ wakeAt' = [wakeAt EXCEPT ![cur[w]] = NextWake(w)]
  /\ ReleaseRow(cur[w]) /\ GoIdle(w)
  /\ UNCHANGED <<now, wfVars, rowExpr, timerFrom, live, faults, lastSlot, observers>>

\* A pass that lost its lease stops at its write and records nothing.
Fenced(w) ==
  /\ pc[w] \in {"fire", "advance"} /\ ~LeaseHeldBy(w)
  /\ GoIdle(w)
  /\ UNCHANGED <<now, wfVars, timerVars, live, faults, lastSlot, observers>>

-----------------------------------------------------------------------------
(* Publish and pause. Each rewrites the timer rows in its own transaction. *)

\* The timer row Publish leaves for schedule s when the new version holds expression e.
NoRow == [r |-> "none", x |-> 0, wake |-> 0, h |-> 0, from |-> 0]
Republished(e, s) ==
  CASE e = pubExpr[s] ->
         [r |-> row[s], x |-> rowExpr[s], wake |-> wakeAt[s], h |-> holder[s], from |-> timerFrom[s]]
    [] e = 0 /\ RemovedTimerIsDeleted -> NoRow
    [] e = 0 ->
         [r |-> row[s], x |-> rowExpr[s], wake |-> wakeAt[s], h |-> holder[s], from |-> timerFrom[s]]
    [] paused -> NoRow
    [] OTHER ->
         LET h == IF EditClearsTheLease THEN 0 ELSE holder[s] IN
         [r |-> IF h # 0 THEN "leased" ELSE "waiting", x |-> e, wake |-> StartWake(e), h |-> h,
          from |-> now]

\* replaceCronTimers in insertPublishedVersion, with the version's activation.
Publish(new) ==
  /\ version <= MaxPublishes
  /\ version' = version + 1 /\ pubExpr' = new
  /\ row'       = [s \in Schedules |-> Republished(new[s], s).r]
  /\ rowExpr'   = [s \in Schedules |-> Republished(new[s], s).x]
  /\ wakeAt'    = [s \in Schedules |-> Republished(new[s], s).wake]
  /\ holder'    = [s \in Schedules |-> Republished(new[s], s).h]
  /\ timerFrom' = [s \in Schedules |-> Republished(new[s], s).from]
  /\ UNCHANGED <<now, mode, paused, toggles, workerVars, live, faults, lastSlot, observers>>

\* setPaused(true): deletes the workflow's timer rows in the same transaction.
Pause ==
  /\ ~paused /\ toggles < MaxToggles
  /\ paused' = TRUE /\ toggles' = toggles + 1
  /\ IF PauseDeletesTimers
       THEN /\ row' = [s \in Schedules |-> NoRow.r] /\ rowExpr' = [s \in Schedules |-> NoRow.x]
            /\ wakeAt' = [s \in Schedules |-> NoRow.wake] /\ holder' = [s \in Schedules |-> NoRow.h]
            /\ timerFrom' = [s \in Schedules |-> NoRow.from]
       ELSE UNCHANGED timerVars
  /\ UNCHANGED <<now, mode, version, pubExpr, workerVars, live, faults, lastSlot, observers>>

\* setPaused(false): a timer row per published schedule, due at its first slot after now.
Resume ==
  /\ paused /\ toggles < MaxToggles
  /\ paused' = FALSE /\ toggles' = toggles + 1
  /\ row' = [s \in Schedules |-> IF pubExpr[s] # 0 THEN "waiting" ELSE "none"]
  /\ rowExpr' = pubExpr
  /\ wakeAt' = [s \in Schedules |-> IF pubExpr[s] = 0 THEN 0 ELSE StartWake(pubExpr[s])]
  /\ holder' = [s \in Schedules |-> 0]
  /\ timerFrom' = [s \in Schedules |-> IF pubExpr[s] = 0 THEN 0 ELSE now]
  /\ UNCHANGED <<now, mode, version, pubExpr, workerVars, live, faults, lastSlot, observers>>

-----------------------------------------------------------------------------
(* Time, faults, and the runs. *)

\* Time passes whether or not a worker has claimed what is due.
Tick ==
  /\ now < MaxTime /\ now' = now + 1
  /\ UNCHANGED <<wfVars, timerVars, workerVars, live, faults, lastSlot, observers>>

LeaseExpires(s) ==
  /\ row[s] = "leased" /\ faults < MaxFaults
  /\ row' = [row EXCEPT ![s] = "waiting"] /\ holder' = [holder EXCEPT ![s] = 0]
  /\ faults' = faults + 1
  /\ UNCHANGED <<now, wfVars, rowExpr, wakeAt, timerFrom, workerVars, live, lastSlot, observers>>

Crash(w) ==
  /\ pc[w] # "idle" /\ faults < MaxFaults
  /\ GoIdle(w) /\ faults' = faults + 1
  /\ UNCHANGED <<now, wfVars, timerVars, live, lastSlot, observers>>

\* The lease sweep frees a row whose holder is no longer working on it.
SweepDeadLease(s) ==
  /\ row[s] = "leased" /\ (pc[holder[s]] = "idle" \/ cur[holder[s]] # s)
  /\ row' = [row EXCEPT ![s] = "waiting"] /\ holder' = [holder EXCEPT ![s] = 0]
  /\ UNCHANGED <<now, wfVars, rowExpr, wakeAt, timerFrom, workerVars, live, faults, lastSlot,
                 observers>>

\* A scheduled run ends, as the run model describes in full.
RunEnds ==
  /\ live > 0 /\ live' = live - 1
  /\ UNCHANGED <<now, wfVars, timerVars, workerVars, faults, lastSlot, observers>>

\* The clock stops at MaxTime.
Stop == now = MaxTime /\ UNCHANGED vars

WorkerStep(w) == (\E s \in Schedules : Claim(w, s)) \/ Fire(w) \/ Advance(w) \/ Fenced(w)

Next ==
  \/ \E w \in Workers : WorkerStep(w) \/ Crash(w)
  \/ \E s \in Schedules : LeaseExpires(s) \/ SweepDeadLease(s)
  \/ \E new \in [Schedules -> {0} \cup Exprs] : Publish(new)
  \/ Pause \/ Resume \/ Tick \/ RunEnds \/ Stop

Spec == Init /\ [][Next]_vars

\* Workers keep working and dead leases are swept. Time, Publishes and pauses
\* are free never to happen.
FairSpec ==
  /\ Spec
  /\ \A w \in Workers : WF_vars(WorkerStep(w))
  /\ \A s \in Schedules : WF_vars(SweepDeadLease(s))

CountersBounded == live <= 2

-----------------------------------------------------------------------------
(* Rules. *)

\* Each schedule fires each slot at most once, an opened run or a Refused
\* Start, and fires its slots in order.
OneFirePerSlot == ~dupFire

\* No fire commits from a pass that lost its lease.
NoFireWithoutTheLease == ~staleFire

\* A fire never opens a run on a paused workflow.
NoFireWhilePaused == ~pausedFire

\* A fire never opens a run for a schedule the published version no longer
\* holds, or holds with another expression.
NoFireForAnUnpublishedSchedule == ~unpublishedFire

\* A timer row exists exactly for each schedule of the published version of an
\* unpaused workflow, written for that schedule's expression.
TimersMatchThePublishedSchedules ==
  \A s \in Schedules :
    /\ (row[s] # "none") = (pubExpr[s] # 0 /\ ~paused)
    /\ row[s] # "none" => rowExpr[s] = pubExpr[s]

\* A fire runs the most recent slot at or before the moment it commits, so a
\* row claimed late fires once, for the slot it missed last.
FireRunsTheLatestSlot == ~notLatest

\* A timer never fires a slot at or before the Publish or resume that wrote it.
NoFireBeforeTheTimerStarted == ~earlyFire

\* A fire opens its run on the version published when the fire commits.
FireRunsThePublishedVersion == ~wrongVersion

\* Concurrency holds for scheduled runs: at most one is live for workflow:<id>.
OneLiveScheduledRun == live <= 1

\* Every timer row that comes due fires, or is deleted.
EveryDueTimerFires ==
  \A s \in Schedules : (row[s] # "none" /\ wakeAt[s] <= now) ~> (row[s] = "none" \/ wakeAt[s] > now)

\* States the model must reach. A pass "about to fire" holds its lease with
\* the fire enabled.
AboutToFire(w) == pc[w] = "fire" /\ LeaseHeldBy(w)
\* The timer row of s has fired since the Publish or resume that wrote it.
CurrentTimerFired(s) == row[s] # "none" /\ lastSlot[s] > timerFrom[s]

ReachMissedSlotsFireOnce == \E w \in Workers : AboutToFire(w) /\ FiredSlot(w) > wakeAt[cur[w]]
ReachRefusedStart        == \E w \in Workers : AboutToFire(w) /\ RefusedStart
ReachSupersede           == \E w \in Workers : AboutToFire(w) /\ mode = "newest" /\ live > 0
ReachKeptTimerFiresOnTheNewVersion == \E w \in Workers : AboutToFire(w) /\ loaded[w] < version
ReachEditedTimerFires    == toggles = 0 /\ pubExpr["a"] = 2 /\ timerFrom["a"] > 0 /\ CurrentTimerFired("a")
ReachAddedTimerFires     == toggles = 0 /\ CurrentTimerFired("b")
ReachResumedTimerFires   == toggles = 2 /\ version = 1 /\ timerFrom["a"] > 0 /\ CurrentTimerFired("a")
ReachFencedByPause       == \E w \in Workers : pc[w] = "fire" /\ paused
ReachFencedByEdit        == \E w \in Workers : pc[w] = "fire" /\ row[cur[w]] # "none"
                                               /\ rowExpr[cur[w]] # claimedExpr[w]
=============================================================================
