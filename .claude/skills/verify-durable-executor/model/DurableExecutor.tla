--------------------------- MODULE DurableExecutor ---------------------------
(***************************************************************************)
(* The Postgres executor proposed as Design A in                           *)
(* docs/internal/plans/separate-event-intake-from-durable-execution.md.    *)
(*                                                                         *)
(* One Execution runs this graph:                                          *)
(*                                                                         *)
(*   Lifecycle --Started--> Wait A --+                                     *)
(*             \           Wait B --+--> Join (an action, may fail)       *)
(*              --Canceled--> Outlet (an action)                           *)
(*                                                                         *)
(* Workers claim the run's row in workflow_execution_schedule under a      *)
(* lease, and the lease holder is the fencing token (owner_token). A pass  *)
(* replays the body against the step memo: it parks a Wait it reaches for  *)
(* the first time, runs a branch past a Wait whose wait row holds a wake,  *)
(* admits and runs the Join, or enters the Canceled outlet, and then       *)
(* releases the row. Producers wake a Wait by writing the wait row and     *)
(* re-queuing a sleeping run.                                              *)
(*                                                                         *)
(* Each action names the section of the design doc it models. Every write  *)
(* a pass makes is one transaction that checks the lease first, as the     *)
(* doc's run(step, fn) does, so each pass action is one atomic step.       *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Workers,      \* worker processes claiming schedule rows
          MaxAttempts   \* the release's `attempt < 4` bound, scaled down

Parks == {"A", "B"}

VARIABLES
  sched,        \* workflow_execution_schedule.state: "queued" | "leased" | "waiting" | "gone"
  holder,       \* owner_token: the worker holding the lease, 0 for none
  attempt,      \* workflow_execution_schedule.attempt, saturating past MaxAttempts
  pc,           \* each worker's place in its pass: "idle" | "visit" | "admit" | "run" | "release"
  passFailed,   \* each worker: whether its current pass hit a retriable step failure
  sawParked,    \* each worker: whether its current pass left a Wait parked
  park,         \* each Wait's row: "unreached" | "open" | "woken" | "cwoken" | "ran" | "halted" | "cancelled"
  claim,        \* workflow_executions.termination_kind: "none" | "cancel"
  status,       \* workflow_executions.status: "running" | "completed" | "canceled" | "failed"
  joinAdmitted, \* memo of the Join's node-admission step
  joinDone,     \* memo of the Join's action step
  outletDone,   \* memo of the Canceled outlet's action step
  \* Observers. They count what happened so the rules below can be stated.
  wakes, branchRuns, joinRuns, outletRuns, terminalWrites, failures,
  startedAfterClaim, commitAfterEnd, policyCanceled

vars == <<sched, holder, attempt, pc, passFailed, sawParked, park, claim, status,
          joinAdmitted, joinDone, outletDone, wakes, branchRuns, joinRuns,
          outletRuns, terminalWrites, failures, startedAfterClaim,
          commitAfterEnd, policyCanceled>>

\* Counters stop one past MaxAttempts: nothing compares them further than that.
Sat(n) == IF n > MaxAttempts + 1 THEN MaxAttempts + 1 ELSE n

\* The guards the design depends on, named so a reader can find each one.
LeaseHeldBy(w) == holder = w                \* run(step, fn) checks owner_token
StartedSideAdmits == claim = "none"         \* createWaitState, openResume and admitNode fences
WakeIsUnclaimed(p) == park[p] = "open"      \* claimWaitState: `status = 'waiting'`
RunInFlight == status = "running"           \* finishRun updates an in-flight row only
ReleaseReadsWaitRows == TRUE                \* the release decides from the wait rows, not the pass's view

Init ==
  /\ sched = "queued" /\ holder = 0 /\ attempt = 0
  /\ pc = [w \in Workers |-> "idle"] /\ passFailed = [w \in Workers |-> FALSE]
  /\ sawParked = [w \in Workers |-> FALSE]
  /\ park = [p \in Parks |-> "unreached"]
  /\ claim = "none" /\ status = "running"
  /\ joinAdmitted = FALSE /\ joinDone = FALSE /\ outletDone = FALSE
  /\ wakes = [p \in Parks |-> 0] /\ branchRuns = [p \in Parks |-> 0]
  /\ joinRuns = 0 /\ outletRuns = 0 /\ terminalWrites = 0 /\ failures = 0
  /\ startedAfterClaim = FALSE /\ commitAfterEnd = FALSE /\ policyCanceled = FALSE

observers == <<wakes, branchRuns, joinRuns, outletRuns, terminalWrites,
               failures, startedAfterClaim, commitAfterEnd, policyCanceled>>

-----------------------------------------------------------------------------
(* Design A, "The invocation", step 1: claim. *)

\* A queued row: `attempt = attempt + (state = 'queued')`.
Claim(w) ==
  /\ sched = "queued" /\ pc[w] = "idle"
  /\ sched' = "leased" /\ holder' = w /\ attempt' = Sat(attempt + 1)
  /\ pc' = [pc EXCEPT ![w] = "visit"] /\ passFailed' = [passFailed EXCEPT ![w] = FALSE]
  /\ sawParked' = [sawParked EXCEPT ![w] = FALSE]
  /\ UNCHANGED <<park, claim, status, joinAdmitted, joinDone, outletDone, observers>>

\* A waiting row whose wake_at passed: the claim resolves that park as a timeout
\* in the same transaction. Only an open park carries a deadline.
ClaimWhenDue(w) ==
  /\ sched = "waiting" /\ pc[w] = "idle"
  /\ \E p \in Parks :
       /\ WakeIsUnclaimed(p)
       /\ park' = [park EXCEPT ![p] = "woken"]
       /\ wakes' = [wakes EXCEPT ![p] = @ + 1]
  /\ sched' = "leased" /\ holder' = w
  /\ pc' = [pc EXCEPT ![w] = "visit"] /\ passFailed' = [passFailed EXCEPT ![w] = FALSE]
  /\ sawParked' = [sawParked EXCEPT ![w] = FALSE]
  /\ UNCHANGED <<attempt, claim, status, joinAdmitted, joinDone, outletDone,
                 branchRuns, joinRuns, outletRuns, terminalWrites, failures,
                 startedAfterClaim, commitAfterEnd, policyCanceled>>

-----------------------------------------------------------------------------
(* Design A, step 3: run. The body replays; each write is fenced on the lease. *)

\* A pass that lost its lease stops at its next write and records nothing.
Fenced(w) ==
  /\ pc[w] \in {"visit", "admit", "run", "release"} /\ ~LeaseHeldBy(w)
  /\ pc' = [pc EXCEPT ![w] = "idle"]
  /\ UNCHANGED <<sched, holder, attempt, passFailed, sawParked, park, claim, status,
                 joinAdmitted, joinDone, outletDone, observers>>

\* Whether this pass runs branch p past its Wait: the wait row holds an Event or
\* timeout wake, and openResume's fence admits Started-side work.
RunsPast(p) == park[p] = "woken" /\ StartedSideAdmits

\* The pass reaches both Waits (section 6.2, a park is a value). A first visit
\* parks the Wait; a woken Wait runs its branch; a claim turns either into a halt.
Visit(w) ==
  /\ pc[w] = "visit" /\ LeaseHeldBy(w)
  /\ park' = [p \in Parks |->
               CASE park[p] = "unreached" -> IF StartedSideAdmits THEN "open" ELSE "halted"
                 [] park[p] = "woken"     -> IF StartedSideAdmits THEN "ran" ELSE "halted"
                 [] park[p] = "cwoken"    -> "halted"
                 [] OTHER                 -> park[p]]
  /\ branchRuns' = [p \in Parks |-> IF RunsPast(p) THEN branchRuns[p] + 1 ELSE branchRuns[p]]
  /\ startedAfterClaim' = (startedAfterClaim \/ \E p \in Parks : RunsPast(p) /\ claim # "none")
  /\ commitAfterEnd' = (commitAfterEnd \/ (status # "running" /\ park' # park))
  /\ sawParked' = [sawParked EXCEPT ![w] = \E p \in Parks : park'[p] = "open"]
  /\ pc' = [pc EXCEPT ![w] = "admit"]
  /\ UNCHANGED <<sched, holder, attempt, passFailed, claim, status, joinAdmitted,
                 joinDone, outletDone, wakes, joinRuns, outletRuns, terminalWrites,
                 failures, policyCanceled>>

\* The boundary below the Waits: a claim routes the Canceled outlet, which runs
\* as a memoized step; otherwise the Join is admitted once both branches ran.
Admit(w) ==
  /\ pc[w] = "admit" /\ LeaseHeldBy(w)
  /\ IF claim = "cancel" /\ ~outletDone
       THEN /\ outletDone' = TRUE /\ outletRuns' = outletRuns + 1
            /\ commitAfterEnd' = (commitAfterEnd \/ status # "running")
            /\ pc' = [pc EXCEPT ![w] = "release"]
            /\ UNCHANGED <<joinAdmitted, startedAfterClaim>>
     ELSE IF \A p \in Parks : park[p] = "ran"
       THEN /\ joinAdmitted' = (joinAdmitted \/ StartedSideAdmits)
            /\ startedAfterClaim' = (startedAfterClaim \/ (~joinAdmitted /\ joinAdmitted' /\ claim # "none"))
            /\ pc' = [pc EXCEPT ![w] = "run"]
            /\ UNCHANGED <<outletDone, outletRuns, commitAfterEnd>>
     ELSE /\ pc' = [pc EXCEPT ![w] = "run"]
          /\ UNCHANGED <<joinAdmitted, outletDone, outletRuns, startedAfterClaim, commitAfterEnd>>
  /\ UNCHANGED <<sched, holder, attempt, passFailed, sawParked, park, claim, status, joinDone,
                 wakes, branchRuns, joinRuns, terminalWrites, failures, policyCanceled>>

\* An admitted Join runs once. Work already admitted may finish after a claim.
JoinSucceeds(w) ==
  /\ pc[w] = "run" /\ LeaseHeldBy(w) /\ joinAdmitted /\ ~joinDone
  /\ joinDone' = TRUE /\ joinRuns' = joinRuns + 1
  /\ commitAfterEnd' = (commitAfterEnd \/ status # "running")
  /\ pc' = [pc EXCEPT ![w] = "release"]
  /\ UNCHANGED <<sched, holder, attempt, passFailed, sawParked, park, claim, status, joinAdmitted,
                 outletDone, wakes, branchRuns, outletRuns, terminalWrites, failures,
                 startedAfterClaim, policyCanceled>>

\* "Retries": the Join's step body throws a retriable error and the pass ends.
JoinFails(w) ==
  /\ pc[w] = "run" /\ LeaseHeldBy(w) /\ joinAdmitted /\ ~joinDone
  /\ passFailed' = [passFailed EXCEPT ![w] = TRUE] /\ failures' = Sat(failures + 1)
  /\ pc' = [pc EXCEPT ![w] = "release"]
  /\ UNCHANGED <<sched, holder, attempt, sawParked, park, claim, status, joinAdmitted, joinDone,
                 outletDone, wakes, branchRuns, joinRuns, outletRuns, terminalWrites,
                 startedAfterClaim, commitAfterEnd, policyCanceled>>

NothingToRun(w) ==
  /\ pc[w] = "run" /\ LeaseHeldBy(w) /\ ~(joinAdmitted /\ ~joinDone)
  /\ pc' = [pc EXCEPT ![w] = "release"]
  /\ UNCHANGED <<sched, holder, attempt, passFailed, sawParked, park, claim, status, joinAdmitted,
                 joinDone, outletDone, observers>>

-----------------------------------------------------------------------------
(* Design A, step 4: release. *)

EndRun(w, final) ==
  /\ status' = IF RunInFlight THEN final ELSE status
  /\ terminalWrites' = terminalWrites + 1
  /\ sched' = "gone"

Release(w) ==
  /\ pc[w] = "release" /\ LeaseHeldBy(w)
  /\ holder' = 0 /\ pc' = [pc EXCEPT ![w] = "idle"]
  /\ CASE outletDone \/ (joinDone /\ claim = "cancel") ->
            \* finishRun refuses a claimed run, which routes the Canceled outlet.
            /\ outletDone' = TRUE /\ outletRuns' = IF outletDone THEN outletRuns ELSE outletRuns + 1
            /\ EndRun(w, "canceled")
            /\ UNCHANGED failures
       [] joinDone ->
            /\ EndRun(w, "completed")
            /\ UNCHANGED <<outletDone, outletRuns, failures>>
       [] passFailed[w] /\ attempt >= MaxAttempts ->
            /\ EndRun(w, "failed")
            /\ UNCHANGED <<outletDone, outletRuns, failures>>
       [] passFailed[w] ->
            /\ sched' = "queued"
            /\ UNCHANGED <<status, terminalWrites, outletDone, outletRuns, failures>>
       [] ReleaseReadsWaitRows /\ \E p \in Parks : park[p] \in {"woken", "cwoken"} ->
            /\ sched' = "queued"
            /\ UNCHANGED <<status, terminalWrites, outletDone, outletRuns, failures>>
       [] \/ \E p \in Parks : park[p] = "open"
          \/ ~ReleaseReadsWaitRows /\ sawParked[w] ->
            /\ sched' = "waiting"
            /\ UNCHANGED <<status, terminalWrites, outletDone, outletRuns, failures>>
       [] OTHER ->
            /\ sched' = "queued"
            /\ UNCHANGED <<status, terminalWrites, outletDone, outletRuns, failures>>
  /\ UNCHANGED <<attempt, passFailed, sawParked, park, claim, joinAdmitted, joinDone, wakes,
                 branchRuns, joinRuns, startedAfterClaim, commitAfterEnd, policyCanceled>>

-----------------------------------------------------------------------------
(* "Lease and liveness". *)

\* The lease runs out under a slow or dead worker: the row is re-queued with the
\* attempt counted, and owner_token is cleared.
LeaseExpires ==
  /\ sched = "leased"
  /\ sched' = "queued" /\ holder' = 0 /\ failures' = Sat(failures + 1)
  /\ UNCHANGED <<attempt, pc, passFailed, sawParked, park, claim, status, joinAdmitted, joinDone,
                 outletDone, wakes, branchRuns, joinRuns, outletRuns, terminalWrites,
                 startedAfterClaim, commitAfterEnd, policyCanceled>>

\* A worker process dies mid-pass. Its lease stays until it expires.
Crash(w) ==
  /\ pc[w] # "idle"
  /\ pc' = [pc EXCEPT ![w] = "idle"]
  /\ UNCHANGED <<sched, holder, attempt, passFailed, sawParked, park, claim, status,
                 joinAdmitted, joinDone, outletDone, observers>>

-----------------------------------------------------------------------------
(* "Resolving a park" and "Cancellation". *)

\* wakeWait: claim the wait row, record the wake, re-queue a sleeping run.
EventWake(p) ==
  /\ RunInFlight /\ claim = "none" /\ WakeIsUnclaimed(p)
  /\ park' = [park EXCEPT ![p] = "woken"] /\ wakes' = [wakes EXCEPT ![p] = @ + 1]
  /\ sched' = IF sched = "waiting" THEN "queued" ELSE sched
  /\ UNCHANGED <<holder, attempt, pc, passFailed, sawParked, claim, status, joinAdmitted, joinDone,
                 outletDone, branchRuns, joinRuns, outletRuns, terminalWrites, failures,
                 startedAfterClaim, commitAfterEnd, policyCanceled>>

\* A Cancel Event: write the claim, resolve every open Started-side park as a
\* cancel wake, and re-queue a sleeping run.
CancelEvent ==
  /\ RunInFlight /\ claim = "none"
  /\ claim' = "cancel"
  /\ park' = [p \in Parks |-> IF park[p] = "open" THEN "cwoken" ELSE park[p]]
  /\ wakes' = [p \in Parks |-> IF park[p] = "open" THEN wakes[p] + 1 ELSE wakes[p]]
  /\ sched' = IF sched = "waiting" THEN "queued" ELSE sched
  /\ UNCHANGED <<holder, attempt, pc, passFailed, sawParked, status, joinAdmitted, joinDone,
                 outletDone, branchRuns, joinRuns, outletRuns, terminalWrites, failures,
                 startedAfterClaim, commitAfterEnd, policyCanceled>>

\* A policy cancel (the Runs view's cancel button, supersede, a refused enqueue):
\* terminal status, schedule row deleted, owner_token cleared, parks cancelled.
PolicyCancel ==
  /\ RunInFlight
  /\ status' = "canceled" /\ policyCanceled' = TRUE /\ terminalWrites' = terminalWrites + 1
  /\ sched' = "gone" /\ holder' = 0
  /\ park' = [p \in Parks |-> IF park[p] \in {"open", "woken", "cwoken"} THEN "cancelled" ELSE park[p]]
  /\ UNCHANGED <<attempt, pc, passFailed, sawParked, claim, joinAdmitted, joinDone, outletDone,
                 wakes, branchRuns, joinRuns, outletRuns, failures, startedAfterClaim,
                 commitAfterEnd>>

\* The run ended and every worker has stopped.
Ended == sched = "gone" /\ \A w \in Workers : pc[w] = "idle" /\ UNCHANGED vars

Next ==
  \/ \E w \in Workers :
       \/ Claim(w) \/ ClaimWhenDue(w) \/ Fenced(w) \/ Visit(w) \/ Admit(w)
       \/ JoinSucceeds(w) \/ JoinFails(w) \/ NothingToRun(w) \/ Release(w) \/ Crash(w)
  \/ \E p \in Parks : EventWake(p)
  \/ LeaseExpires \/ CancelEvent \/ PolicyCancel \/ Ended

Spec == Init /\ [][Next]_vars

\* Keeps a mutated model finite. In the model as written every counter stays at
\* most 1 whenever its rule holds, so this bound only cuts states in which a
\* rule has already broken.
CountersBounded ==
  /\ \A p \in Parks : wakes[p] <= 2 /\ branchRuns[p] <= 2
  /\ joinRuns <= 2 /\ outletRuns <= 2 /\ terminalWrites <= 2

-----------------------------------------------------------------------------
(* Rules. Each is one sentence a reader of the design doc agrees to. *)

\* A run never sleeps while one of its branches has been woken and not yet run.
WokenBranchIsNeverStranded == sched = "waiting" => \A p \in Parks : park[p] \notin {"woken", "cwoken"}

\* A sleeping run always has a deadline to wake it, from at least one open Wait.
SleepingRunHasADeadline == sched = "waiting" => \E p \in Parks : park[p] = "open"

\* Each Wait is woken at most once: an Event, its timeout and a cancel never both win.
EachWaitWokenOnce == \A p \in Parks : wakes[p] <= 1

\* Each branch runs past its Wait at most once.
EachBranchRunsOnce == \A p \in Parks : branchRuns[p] <= 1

\* The Join runs at most once, and only after both branches ran past their Waits.
JoinRunsOnceAfterBothBranches ==
  /\ joinRuns <= 1
  /\ joinRuns = 1 => \A p \in Parks : branchRuns[p] = 1

\* The Canceled outlet runs at most once, and only for a run a Cancel Event claimed.
OutletRunsOnceOnCancelClaim == outletRuns <= 1 /\ (outletRuns = 1 => claim = "cancel")

\* No Started-side work is admitted after a Cancel Event claims the run.
NoStartedWorkAdmittedAfterClaim == ~startedAfterClaim

\* Nothing commits after the run has ended.
NothingCommitsAfterTheRunEnds == ~commitAfterEnd

\* The run's terminal record is written once.
OneTerminalRecord == terminalWrites <= 1

\* A completed run ran the Join; a Cancel Event's cancellation ran the outlet.
EndMatchesWork ==
  /\ status = "completed" => joinDone /\ claim = "none"
  /\ (status = "canceled" /\ ~policyCanceled) => outletDone

\* A run is marked failed only after its retries were spent on failures.
FailedOnlyAfterRetriesSpent == status = "failed" => failures >= MaxAttempts

\* A leased row has a lease holder, and no other row does.
LeaseHasAHolder == (sched = "leased") = (holder # 0)
=============================================================================
