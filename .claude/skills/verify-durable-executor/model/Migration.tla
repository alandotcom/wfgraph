------------------------------ MODULE Migration ------------------------------
(***************************************************************************)
(* Migration of a parked run under the executor proposed as Design A in    *)
(* docs/internal/plans/separate-event-intake-from-durable-execution.md,    *)
(* section "Migration", with the semantics of ADR-0019.                    *)
(*                                                                         *)
(* One Execution runs   Lifecycle --> Above --> Wait --> Below   and is    *)
(* pinned to version 1 or 2. Both versions have the Wait; Below differs    *)
(* between them. A Migration repins a parked run (repinVersion, guarded on *)
(* the run waiting at that Wait) and then sends a migrate wake to the      *)
(* parked row. A pass loads the pinned version once, when it claims the   *)
(* run, and every write the Wait makes is fenced on that version still    *)
(* being pinned: createWaitState, reparkWaitState, and markExecutionRunning *)
(* in openResume. A refused fence ends the pass without counting an       *)
(* attempt, and the next pass loads the version the run now pins. Each     *)
(* version's Wait is event-mode or delay-mode, and every pairing of the    *)
(* two is checked, so a Migration can change the Wait's mode. An Event     *)
(* wakes only a park in event mode: claimWaitState requires it.            *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Workers, MaxAttempts, MaxFaults, MaxMigrations

Versions == {1, 2}
Other(v) == IF v = 1 THEN 2 ELSE 1

VARIABLES
  sched,        \* workflow_execution_schedule.state: "queued" | "leased" | "waiting" | "gone"
  holder,       \* owner_token: the worker holding the lease, 0 for none
  attempt,      \* workflow_execution_schedule.attempt, saturating past MaxAttempts
  faults,       \* crashes and expired leases so far in this behaviour
  pc,           \* each worker: "idle" | "above" | "prepare" | "park" | "below" | "release"
  loaded,       \* each worker: the version its pass loaded when it claimed the run
  passFailed,   \* each worker: whether its pass ended on a refused fence (a retry)
  sawParked,    \* each worker: whether its pass left the Wait parked
  pinned,       \* workflow_executions.workflow_version_id
  status,       \* workflow_executions.status: "running" | "completed" | "failed"
  aboveDone,    \* memo of the node above the Wait
  row,          \* the Wait's row: "none" | "waiting" | "event" | "timeout" | "migrate" | "resumed"
  rowVersion,   \* the version the parked row was prepared from
  mode,         \* each version's Wait: "event" | "delay", fixed for the behaviour
  rowMode,      \* the mode the parked row was prepared in
  migrateDue,   \* a repinned run whose migrate wake has not been sent
  belowDone,    \* memo of the node below the Wait
  \* Observers.
  migrations, aboveRuns, belowRuns, belowVersionWrong, hopWakes, terminalWrites,
  failures, eventWokeDelay,
  eventLost     \* an Event the Wait subscribes to was refused because a migrate wake was pending

vars == <<sched, holder, attempt, faults, pc, loaded, passFailed, sawParked, pinned, status,
          aboveDone, row, rowVersion, mode, rowMode, migrateDue, belowDone, migrations,
          aboveRuns, belowRuns, belowVersionWrong, hopWakes, terminalWrites, failures,
          eventWokeDelay, eventLost>>

Sat(n) == IF n > MaxAttempts + 1 THEN MaxAttempts + 1 ELSE n

\* The guards the design depends on.
LeaseHeldBy(w) == holder = w                     \* run(step, fn) checks owner_token
StillPinned(w) == pinned = loaded[w]             \* the version fence on every Wait write
RepinNeedsAPark == row = "waiting"               \* repinVersion: run waiting at this Wait
WakeIsUnclaimed == row = "waiting"               \* claimWaitState: `status = 'waiting'`
EventWakeNeedsAnEventPark == rowMode = "event"   \* claimWaitState: `wait_type = 'event'`
EventReplacesMigrateWake == TRUE                 \* claimWaitState takes a row whose pending wake is a migrate wake

\* A row an Event may wake: still waiting, or holding a migrate wake no pass has acted on.
EventMayTake == WakeIsUnclaimed \/ (EventReplacesMigrateWake /\ row = "migrate")
ReparkMode(w) == mode[loaded[w]]                 \* reparkWaitState writes the loaded version's mode
ReleaseReadsWaitRow == TRUE                      \* the release decides from the wait row, not the pass's view
FenceRefusalCountsNoAttempt == TRUE              \* "Migration": a refused fence re-queues with the attempt unchanged

Init ==
  /\ sched = "queued" /\ holder = 0 /\ attempt = 0 /\ faults = 0
  /\ pc = [w \in Workers |-> "idle"] /\ loaded = [w \in Workers |-> 1]
  /\ passFailed = [w \in Workers |-> FALSE] /\ sawParked = [w \in Workers |-> FALSE]
  /\ pinned = 1 /\ status = "running" /\ aboveDone = FALSE
  /\ row = "none" /\ rowVersion = 1 /\ migrateDue = FALSE /\ belowDone = FALSE
  /\ mode \in [Versions -> {"event", "delay"}] /\ rowMode = "event" /\ eventWokeDelay = FALSE
  /\ eventLost = FALSE
  /\ migrations = 0 /\ aboveRuns = 0 /\ belowRuns = 0 /\ belowVersionWrong = FALSE
  /\ hopWakes = 0 /\ terminalWrites = 0 /\ failures = 0

shared == <<sched, holder, attempt, faults, pinned, status, aboveDone, row,
            rowVersion, mode, rowMode, migrateDue, belowDone>>
observers == <<migrations, aboveRuns, belowRuns, belowVersionWrong, hopWakes,
               terminalWrites, failures, eventWokeDelay, eventLost>>

Go(w, next) == pc' = [pc EXCEPT ![w] = next]

\* The pass ends on a refused version fence.
FenceRefused(w) ==
  /\ passFailed' = [passFailed EXCEPT ![w] = TRUE] /\ Go(w, "release")

-----------------------------------------------------------------------------
(* Claim. The pass loads the pinned version once. *)

StartPass(w) ==
  /\ holder' = w /\ sched' = "leased"
  /\ loaded' = [loaded EXCEPT ![w] = pinned]
  /\ passFailed' = [passFailed EXCEPT ![w] = FALSE]
  /\ sawParked' = [sawParked EXCEPT ![w] = FALSE]
  /\ Go(w, "above")

Claim(w) ==
  /\ sched = "queued" /\ pc[w] = "idle" /\ StartPass(w)
  /\ UNCHANGED <<attempt, faults, pinned, status, aboveDone, row, rowVersion, mode, rowMode,
                 migrateDue, belowDone, observers>>

\* The Wait's deadline passed: the claim resolves the park as a timeout.
ClaimWhenDue(w) ==
  /\ sched = "waiting" /\ pc[w] = "idle" /\ row = "waiting"
  /\ row' = "timeout" /\ hopWakes' = hopWakes + 1
  /\ StartPass(w)
  /\ UNCHANGED <<attempt, faults, pinned, status, aboveDone, rowVersion, mode, rowMode, migrateDue,
                 belowDone, migrations, aboveRuns, belowRuns, belowVersionWrong,
                 terminalWrites, failures, eventWokeDelay, eventLost>>

-----------------------------------------------------------------------------
(* The pass. *)

Fenced(w) ==
  /\ pc[w] # "idle" /\ ~LeaseHeldBy(w)
  /\ Go(w, "idle")
  /\ UNCHANGED <<shared, loaded, passFailed, sawParked, observers>>

\* The node above the Wait runs once; a replay reads its memo.
Above(w) ==
  /\ pc[w] = "above" /\ LeaseHeldBy(w)
  /\ aboveDone' = TRUE /\ aboveRuns' = IF aboveDone THEN aboveRuns ELSE aboveRuns + 1
  /\ Go(w, "prepare")
  /\ UNCHANGED <<sched, holder, attempt, faults, loaded, passFailed, sawParked, pinned, status,
                 row, rowVersion, mode, rowMode, migrateDue, belowDone, migrations, belowRuns,
                 belowVersionWrong, hopWakes, terminalWrites, failures, eventWokeDelay, eventLost>>

\* The Wait's first attempt: createWaitState, fenced on the loaded version.
Prepare(w) ==
  /\ pc[w] = "prepare" /\ LeaseHeldBy(w)
  /\ IF row = "none"
       THEN IF StillPinned(w)
              THEN /\ row' = "waiting" /\ rowVersion' = loaded[w]
                   /\ rowMode' = mode[loaded[w]]
                   /\ Go(w, "park") /\ UNCHANGED passFailed
              ELSE /\ FenceRefused(w) /\ UNCHANGED <<row, rowVersion, rowMode>>
       ELSE /\ Go(w, "park") /\ UNCHANGED <<row, rowVersion, rowMode, passFailed>>
  /\ UNCHANGED <<sched, holder, attempt, faults, loaded, sawParked, pinned, status, aboveDone, mode,
                 migrateDue, belowDone, observers>>

\* The park reads the row. A migrate wake re-prepares the Wait from the loaded
\* version (reparkWaitState, fenced) and parks again on a new hop. An Event or
\* timeout wake resumes behind openResume's fence (markExecutionRunning).
Park(w) ==
  /\ pc[w] = "park" /\ LeaseHeldBy(w)
  /\ sawParked' = [sawParked EXCEPT ![w] = (row = "waiting")]
  /\ CASE row = "waiting" ->
            /\ Go(w, "release") /\ UNCHANGED <<row, rowVersion, rowMode, passFailed, hopWakes>>
       [] row = "migrate" ->
            IF StillPinned(w)
              THEN /\ row' = "waiting" /\ rowVersion' = loaded[w] /\ hopWakes' = 0
                   /\ rowMode' = ReparkMode(w)
                   /\ Go(w, "release") /\ UNCHANGED passFailed
              ELSE /\ FenceRefused(w) /\ UNCHANGED <<row, rowVersion, rowMode, hopWakes>>
       [] row \in {"event", "timeout"} ->
            IF StillPinned(w)
              THEN /\ row' = "resumed" /\ Go(w, "below")
                   /\ UNCHANGED <<rowVersion, rowMode, passFailed, hopWakes>>
              ELSE /\ FenceRefused(w) /\ UNCHANGED <<row, rowVersion, rowMode, hopWakes>>
       [] row = "resumed" ->
            /\ Go(w, "below") /\ UNCHANGED <<row, rowVersion, rowMode, passFailed, hopWakes>>
  /\ UNCHANGED <<sched, holder, attempt, faults, loaded, pinned, status, aboveDone, mode,
                 migrateDue, belowDone, migrations, aboveRuns, belowRuns,
                 belowVersionWrong, terminalWrites, failures, eventWokeDelay, eventLost>>

\* The node below the Wait runs once, from the loaded version's definition.
Below(w) ==
  /\ pc[w] = "below" /\ LeaseHeldBy(w)
  /\ belowDone' = TRUE /\ belowRuns' = IF belowDone THEN belowRuns ELSE belowRuns + 1
  /\ belowVersionWrong' = (belowVersionWrong \/ (~belowDone /\ loaded[w] # pinned))
  /\ Go(w, "release")
  /\ UNCHANGED <<sched, holder, attempt, faults, loaded, passFailed, sawParked, pinned, status,
                 aboveDone, row, rowVersion, mode, rowMode, migrateDue, migrations, aboveRuns,
                 hopWakes, terminalWrites, failures, eventWokeDelay, eventLost>>

Release(w) ==
  /\ pc[w] = "release" /\ LeaseHeldBy(w)
  /\ holder' = 0 /\ Go(w, "idle")
  /\ CASE belowDone ->
            /\ status' = "completed" /\ sched' = "gone" /\ terminalWrites' = terminalWrites + 1
            /\ UNCHANGED attempt
       [] passFailed[w] /\ ~FenceRefusalCountsNoAttempt /\ attempt + 1 >= MaxAttempts ->
            /\ status' = "failed" /\ sched' = "gone" /\ terminalWrites' = terminalWrites + 1
            /\ UNCHANGED attempt
       [] passFailed[w] ->
            /\ sched' = "queued"
            /\ attempt' = IF FenceRefusalCountsNoAttempt THEN attempt ELSE Sat(attempt + 1)
            /\ UNCHANGED <<status, terminalWrites>>
       [] ReleaseReadsWaitRow /\ row \in {"event", "timeout", "migrate"} ->
            /\ sched' = "queued" /\ UNCHANGED <<attempt, status, terminalWrites>>
       [] row = "waiting" \/ (~ReleaseReadsWaitRow /\ sawParked[w]) ->
            /\ sched' = "waiting" /\ UNCHANGED <<attempt, status, terminalWrites>>
       [] OTHER ->
            /\ sched' = "queued" /\ UNCHANGED <<attempt, status, terminalWrites>>
  /\ UNCHANGED <<faults, loaded, passFailed, sawParked, pinned, aboveDone, row, rowVersion, mode, rowMode,
                 migrateDue, belowDone, migrations, aboveRuns, belowRuns,
                 belowVersionWrong, hopWakes, failures, eventWokeDelay, eventLost>>

-----------------------------------------------------------------------------
(* Faults. *)

LeaseExpires ==
  /\ sched = "leased" /\ faults < MaxFaults
  /\ sched' = "queued" /\ holder' = 0 /\ faults' = faults + 1
  /\ attempt' = Sat(attempt + 1) /\ failures' = Sat(failures + 1)
  /\ UNCHANGED <<pc, loaded, passFailed, sawParked, pinned, status, aboveDone, row, rowVersion, mode, rowMode,
                 migrateDue, belowDone, migrations, aboveRuns, belowRuns,
                 belowVersionWrong, hopWakes, terminalWrites, eventWokeDelay, eventLost>>

Crash(w) ==
  /\ pc[w] # "idle" /\ faults < MaxFaults
  /\ Go(w, "idle") /\ faults' = faults + 1
  /\ UNCHANGED <<sched, holder, attempt, loaded, passFailed, sawParked, pinned, status, aboveDone,
                 row, rowVersion, mode, rowMode, migrateDue, belowDone, observers>>

SweepDeadLease ==
  /\ sched = "leased" /\ holder # 0 /\ pc[holder] = "idle"
  /\ sched' = "queued" /\ holder' = 0 /\ attempt' = Sat(attempt + 1)
  /\ failures' = Sat(failures + 1)
  /\ UNCHANGED <<faults, pc, loaded, passFailed, sawParked, pinned, status, aboveDone, row,
                 rowVersion, mode, rowMode, migrateDue, belowDone, migrations, aboveRuns, belowRuns,
                 belowVersionWrong, hopWakes, terminalWrites, eventWokeDelay, eventLost>>

-----------------------------------------------------------------------------
(* Producers. Each locks the schedule row first, so each is one step. *)

Requeue == sched' = IF sched = "waiting" THEN "queued" ELSE sched

\* migrateExecutions, part one: repin a run parked at this Wait.
Repin ==
  /\ status = "running" /\ RepinNeedsAPark /\ ~migrateDue /\ migrations < MaxMigrations
  /\ pinned' = Other(pinned) /\ migrateDue' = TRUE /\ migrations' = migrations + 1
  /\ UNCHANGED <<sched, holder, attempt, faults, pc, loaded, passFailed, sawParked, status,
                 aboveDone, row, rowVersion, mode, rowMode, belowDone, aboveRuns, belowRuns,
                 belowVersionWrong, hopWakes, terminalWrites, failures, eventWokeDelay, eventLost>>

\* migrateExecutions, part two: the migrate wake on the parked row. A row
\* another wake already took needs none, since its resume fails the fence and
\* the retry loads the new version.
MigrateWake ==
  /\ migrateDue
  /\ migrateDue' = FALSE
  /\ IF WakeIsUnclaimed /\ status = "running"
       THEN row' = "migrate" /\ Requeue
       ELSE UNCHANGED <<row, sched>>
  /\ UNCHANGED <<holder, attempt, faults, pc, loaded, passFailed, sawParked, pinned, status,
                 aboveDone, rowVersion, mode, rowMode, belowDone, observers>>

\* The driver's resolvePark for an Event the Wait subscribes to. An Event that finds the row
\* holding a migrate wake replaces it: the next pass reads the Event, fails the
\* version fence, and resumes on the version the run was moved to.
EventWake ==
  /\ status = "running" /\ EventMayTake /\ EventWakeNeedsAnEventPark
  /\ row' = "event" /\ hopWakes' = hopWakes + 1 /\ Requeue
  /\ eventWokeDelay' = (eventWokeDelay \/ rowMode = "delay")
  /\ UNCHANGED <<holder, attempt, faults, pc, loaded, passFailed, sawParked, pinned, status,
                 aboveDone, rowVersion, mode, rowMode, migrateDue, belowDone, migrations, aboveRuns,
                 belowRuns, belowVersionWrong, terminalWrites, failures, eventLost>>

\* An Event the Wait subscribes to arrives while a migrate wake is pending, and
\* the claim refuses it, so the run never sees that Event.
EventRefused ==
  /\ status = "running" /\ row = "migrate" /\ EventWakeNeedsAnEventPark /\ ~EventMayTake
  /\ ~eventLost /\ eventLost' = TRUE
  /\ UNCHANGED <<sched, holder, attempt, faults, pc, loaded, passFailed, sawParked, pinned, status,
                 aboveDone, row, rowVersion, mode, rowMode, migrateDue, belowDone, migrations,
                 aboveRuns, belowRuns, belowVersionWrong, hopWakes, terminalWrites, failures,
                 eventWokeDelay>>

Ended == sched = "gone" /\ ~migrateDue /\ \A w \in Workers : pc[w] = "idle" /\ UNCHANGED vars

WorkerStep(w) ==
  \/ Claim(w) \/ ClaimWhenDue(w) \/ Fenced(w) \/ Above(w) \/ Prepare(w) \/ Park(w)
  \/ Below(w) \/ Release(w)

Next ==
  \/ \E w \in Workers : WorkerStep(w) \/ Crash(w)
  \/ LeaseExpires \/ SweepDeadLease \/ Repin \/ MigrateWake \/ EventWake \/ EventRefused \/ Ended

Spec == Init /\ [][Next]_vars

\* Workers keep working, dead leases are swept, and the Migration service sends
\* the migrate wake it owes.
FairSpec == Spec /\ \A w \in Workers : WF_vars(WorkerStep(w))
                 /\ WF_vars(SweepDeadLease) /\ WF_vars(MigrateWake)

CountersBounded == aboveRuns <= 2 /\ belowRuns <= 2 /\ hopWakes <= 2 /\ terminalWrites <= 2

-----------------------------------------------------------------------------
(* Rules. *)

\* A Migration never re-runs a node above the Wait.
AboveRunsOnce == aboveRuns <= 1

\* The node below the Wait runs once.
BelowRunsOnce == belowRuns <= 1

\* The node below the Wait runs the definition of the version the run pins when it runs.
BelowRunsThePinnedVersion == ~belowVersionWrong

\* Each park of the Wait is resumed by at most one Event or timeout.
EachHopWokenOnce == hopWakes <= 1

\* A sleeping run is parked on a row prepared from the version it pins, unless
\* its migrate wake is still on the way.
ParkedUnderThePinnedVersion ==
  (sched = "waiting" /\ row = "waiting" /\ ~migrateDue) => rowVersion = pinned

\* An Event wakes only a Wait parked in event mode: a delay Wait answers none.
EventOnlyWakesAnEventPark == ~eventWokeDelay

\* A sleeping run is parked in the mode the version it pins gives its Wait,
\* unless its migrate wake is still on the way.
ParkedInThePinnedMode ==
  (sched = "waiting" /\ row = "waiting" /\ ~migrateDue) => rowMode = mode[pinned]

\* An Event the Wait subscribes to is never refused because a Migration's
\* wake reached the row first.
NoEventLostToAMigrateWake == ~eventLost

\* A run never sleeps while its Wait holds a wake nobody has acted on.
WokenWaitIsNeverStranded == sched = "waiting" => row = "waiting"

OneTerminalRecord == terminalWrites <= 1

\* A run is marked failed only after its retries were spent on failures.
FailedOnlyAfterRetriesSpent == status = "failed" => failures >= MaxAttempts

LeaseHasAHolder == (sched = "leased") = (holder # 0)

\* Every run ends.
EveryRunEnds == <>(status # "running")

ReachMigratedAndCompleted == status = "completed" /\ migrations >= 1 /\ pinned = 2
ReachReparkedOnNewVersion == row = "waiting" /\ rowVersion = 2
ReachFenceRefusedResume   == \E w \in Workers : passFailed[w] /\ pc[w] = "release" /\ row \in {"event", "timeout"}
ReachMigratedBackAndForth == migrations = 2 /\ status = "completed"
ReachEventBeatsMigrateWake == row = "event" /\ migrateDue
ReachReparkedInTheOtherMode == row = "waiting" /\ rowVersion = 2 /\ rowMode # mode[1]
ReachEventReplacesMigrateWake == row = "event" /\ rowVersion # pinned
ReachEventResumesAcrossAModeChange == row = "resumed" /\ rowMode = "event" /\ mode[pinned] = "delay"
=============================================================================
