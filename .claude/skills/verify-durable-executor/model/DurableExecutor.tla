--------------------------- MODULE DurableExecutor ---------------------------
(***************************************************************************)
(* The Postgres executor proposed as Design A in                           *)
(* docs/internal/plans/separate-event-intake-from-durable-execution.md.    *)
(*                                                                         *)
(* One Execution runs this graph:                                          *)
(*                                                                         *)
(*   Lifecycle --Started--> Wait A --+                                     *)
(*             \           Wait B --+--> Join (an action, may fail)       *)
(*              --Canceled--> Wait C --> Outlet (an action)                *)
(*                                                                         *)
(* Workers claim the run's row in workflow_execution_schedule under a      *)
(* lease, and the lease holder is the fencing token (owner_token). A pass  *)
(* replays the body against the step memo: it parks a Wait it reaches for  *)
(* the first time, runs the work below a Wait whose wait row holds a wake, *)
(* checks Entity Eligibility before Started-side work, admits and runs the *)
(* Join, enters the Canceled outlet once a Cancel Event claimed the run,   *)
(* and then releases the row. Producers wake a Wait by writing its wait    *)
(* row and re-queuing a sleeping run, after locking the schedule row.      *)
(*                                                                         *)
(* Each action names the section of the design doc it models. Every write  *)
(* a pass makes is one transaction that checks the lease first, as the     *)
(* doc's run(step, fn) does, so each pass action is one atomic step.       *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Workers,      \* worker processes claiming schedule rows
          MaxAttempts,  \* the release's "at most four" retries, scaled down
          MaxFaults     \* how many crashes and expired leases one behaviour may have

Started == {"A", "B"}
Parks   == Started \cup {"C"}

VARIABLES
  sched,          \* workflow_execution_schedule.state: "queued" | "leased" | "waiting" | "gone"
  holder,         \* owner_token: the worker holding the lease, 0 for none
  attempt,        \* workflow_execution_schedule.attempt, saturating past MaxAttempts
  faults,         \* crashes and expired leases so far in this behaviour
  pc,             \* each worker's place in its pass:
                  \*   "idle" | "visit" | "admit" | "canceled" | "run" | "release"
  passFailed,     \* each worker: whether its current pass hit a retriable step failure
  sawParked,      \* each worker: whether its current pass left a Wait parked
  park,           \* each Wait's row: "unreached" | "open" | "woken" | "hwoken"
                  \*   | "ran" | "halted" | "cancelled"
                  \* "woken" holds an Event or timeout wake; "hwoken" a cancel or exit wake
  claim,          \* workflow_executions.termination_kind: "none" | "cancel" | "exit"
  status,         \* workflow_executions.status:
                  \*   "running" | "completed" | "canceled" | "exited" | "failed"
  joinAdmitted,   \* memo of the Join's node-admission step
  joinDone,       \* memo of the Join's action step
  joinFailed,     \* memo of the Join failing for good, once its retries ran out
  canceledEntered,\* memo of the lifecycle-check step that routed the Canceled outlet
  \* Observers. They count what happened so the rules below can be stated.
  wakes, branchRuns, joinRuns, canceledEntries, terminalWrites, failures,
  claimWrites, startedWorkAfterClaim, canceledWorkAfterExit, commitAfterEnd,
  policyCanceled

runVars    == <<sched, holder, attempt, faults>>
workerVars == <<pc, passFailed, sawParked>>
dataVars   == <<park, claim, status, joinAdmitted, joinDone, joinFailed, canceledEntered>>
observers  == <<wakes, branchRuns, joinRuns, canceledEntries, terminalWrites,
                failures, claimWrites, startedWorkAfterClaim,
                canceledWorkAfterExit, commitAfterEnd, policyCanceled>>
vars == <<runVars, workerVars, dataVars, observers>>

\* Counters stop one past MaxAttempts: nothing compares them further than that.
Sat(n) == IF n > MaxAttempts + 1 THEN MaxAttempts + 1 ELSE n

Woken == {"woken", "hwoken"}

\* The guards the design depends on, named so a reader can find each one.
LeaseHeldBy(w) == holder = w                  \* run(step, fn) checks owner_token
StartedSideAdmits == claim = "none"           \* createWaitState, openResume and admitNode fences
CanceledSideAdmits == claim = "cancel"        \* a Cancel claim admits the Canceled side, an Exit refuses it
WakeIsUnclaimed(p) == park[p] = "open"        \* claimWaitState: `status = 'waiting'`
ParkIsDue(p) == park[p] = "open"              \* the claim's `wake_at <= now()`: only an open park has a deadline
ClaimIsFree == claim = "none"                 \* requestCancelForEntity and requestExit write a free claim only
RunInFlight == status = "running"             \* finishRun updates an in-flight row only
ReleaseReadsWaitRows == TRUE                  \* the release decides from the wait rows, not the pass's view
FailedNodeEndsRun == claim = "none"           \* "Retries": a node that failed for good ends the run only when no claim has work left

Init ==
  /\ sched = "queued" /\ holder = 0 /\ attempt = 0 /\ faults = 0
  /\ pc = [w \in Workers |-> "idle"]
  /\ passFailed = [w \in Workers |-> FALSE] /\ sawParked = [w \in Workers |-> FALSE]
  /\ park = [p \in Parks |-> "unreached"]
  /\ claim = "none" /\ status = "running"
  /\ joinAdmitted = FALSE /\ joinDone = FALSE /\ joinFailed = FALSE /\ canceledEntered = FALSE
  /\ wakes = [p \in Parks |-> 0] /\ branchRuns = [p \in Parks |-> 0]
  /\ joinRuns = 0 /\ canceledEntries = 0 /\ terminalWrites = 0 /\ failures = 0
  /\ claimWrites = 0 /\ startedWorkAfterClaim = FALSE /\ canceledWorkAfterExit = FALSE
  /\ commitAfterEnd = FALSE /\ policyCanceled = FALSE

\* A worker's pass moves to its next stage and changes nothing else.
Advance(w, next) ==
  /\ pc' = [pc EXCEPT ![w] = next]
  /\ UNCHANGED <<runVars, passFailed, sawParked, dataVars, observers>>

-----------------------------------------------------------------------------
(* Design A, "The invocation", step 1: claim. The claim leaves attempt alone. *)

StartPass(w) ==
  /\ holder' = w /\ sched' = "leased"
  /\ pc' = [pc EXCEPT ![w] = "visit"]
  /\ passFailed' = [passFailed EXCEPT ![w] = FALSE]
  /\ sawParked' = [sawParked EXCEPT ![w] = FALSE]

Claim(w) ==
  /\ sched = "queued" /\ pc[w] = "idle"
  /\ StartPass(w)
  /\ UNCHANGED <<attempt, faults, dataVars, observers>>

\* A waiting row whose wake_at passed: the claim resolves that park as a timeout
\* in the same transaction.
ClaimWhenDue(w) ==
  /\ sched = "waiting" /\ pc[w] = "idle"
  /\ \E p \in Parks :
       /\ ParkIsDue(p)
       /\ park' = [park EXCEPT ![p] = "woken"]
       /\ wakes' = [wakes EXCEPT ![p] = @ + 1]
  /\ StartPass(w)
  /\ UNCHANGED <<attempt, faults, claim, status, joinAdmitted, joinDone, joinFailed, canceledEntered,
                 branchRuns, joinRuns, canceledEntries, terminalWrites, failures,
                 claimWrites, startedWorkAfterClaim, canceledWorkAfterExit,
                 commitAfterEnd, policyCanceled>>

-----------------------------------------------------------------------------
(* Design A, step 3: run. The body replays; each write is fenced on the lease. *)

\* A pass that lost its lease stops at its next write and records nothing.
Fenced(w) ==
  /\ pc[w] \in {"visit", "admit", "canceled", "run", "release"} /\ ~LeaseHeldBy(w)
  /\ Advance(w, "idle")

\* Whether this pass runs the work below Started-side Wait p: the wait row holds
\* an Event or timeout wake, and openResume's fence admits Started-side work.
RunsPast(p) == park[p] = "woken" /\ StartedSideAdmits

\* The pass reaches both Started-side Waits (section 6.2, a park is a value). A
\* first visit parks the Wait; a woken Wait runs its branch; a claim, or a wake
\* a claim sent, halts it.
VisitStarted(w) ==
  /\ pc[w] = "visit" /\ LeaseHeldBy(w)
  /\ park' = [p \in Parks |->
               IF p \notin Started THEN park[p] ELSE
               CASE park[p] = "unreached" -> IF StartedSideAdmits THEN "open" ELSE "halted"
                 [] park[p] = "woken"     -> IF StartedSideAdmits THEN "ran" ELSE "halted"
                 [] park[p] = "hwoken"    -> "halted"
                 [] OTHER                 -> park[p]]
  /\ branchRuns' = [p \in Parks |-> IF p \in Started /\ RunsPast(p) THEN branchRuns[p] + 1 ELSE branchRuns[p]]
  /\ startedWorkAfterClaim' = (startedWorkAfterClaim \/ \E p \in Started : RunsPast(p) /\ claim # "none")
  /\ commitAfterEnd' = (commitAfterEnd \/ (status # "running" /\ park' # park))
  /\ sawParked' = [sawParked EXCEPT ![w] = \E p \in Parks : park'[p] = "open"]
  /\ pc' = [pc EXCEPT ![w] = "admit"]
  /\ UNCHANGED <<runVars, passFailed, claim, status, joinAdmitted, joinDone, joinFailed,
                 canceledEntered, wakes, joinRuns, canceledEntries, terminalWrites,
                 failures, claimWrites, canceledWorkAfterExit, policyCanceled>>

\* "Exit claim": Entity Eligibility refuses the work below a woken Started-side
\* Wait. The run claims an Exit and resolves its sibling parks as exit wakes in
\* the same step. The refused branch halts.
ExitBeforeBranch(w) ==
  /\ pc[w] = "visit" /\ LeaseHeldBy(w) /\ ClaimIsFree
  /\ \E p \in Started :
       /\ RunsPast(p)
       /\ park' = [q \in Parks |-> CASE q = p             -> "halted"
                                     [] park[q] = "open"  -> "hwoken"
                                     [] OTHER             -> park[q]]
       /\ wakes' = [q \in Parks |-> IF q # p /\ park[q] = "open" THEN wakes[q] + 1 ELSE wakes[q]]
  /\ claim' = "exit" /\ claimWrites' = claimWrites + 1
  /\ commitAfterEnd' = (commitAfterEnd \/ status # "running")
  /\ UNCHANGED <<runVars, workerVars, status, joinAdmitted, joinDone, joinFailed, canceledEntered,
                 branchRuns, joinRuns, canceledEntries, terminalWrites, failures,
                 startedWorkAfterClaim, canceledWorkAfterExit, policyCanceled>>

\* The boundary below the Started side. A Cancel claim routes the Canceled
\* outlet once; that lifecycle-check step is memoized.
EnterCanceledOutlet(w) ==
  /\ pc[w] = "admit" /\ LeaseHeldBy(w)
  /\ claim = "cancel" /\ ~canceledEntered
  /\ canceledEntered' = TRUE /\ canceledEntries' = canceledEntries + 1
  /\ canceledWorkAfterExit' = (canceledWorkAfterExit \/ claim = "exit")
  /\ commitAfterEnd' = (commitAfterEnd \/ status # "running")
  /\ pc' = [pc EXCEPT ![w] = "canceled"]
  /\ UNCHANGED <<runVars, passFailed, sawParked, park, claim, status, joinAdmitted,
                 joinDone, joinFailed, wakes, branchRuns, joinRuns, terminalWrites, failures,
                 claimWrites, startedWorkAfterClaim, policyCanceled>>

JoinIsDue == /\ ~joinAdmitted /\ \A p \in Started : park[p] = "ran"

\* Entity Eligibility admits the Join: admitNode records the admission.
AdmitJoin(w) ==
  /\ pc[w] = "admit" /\ LeaseHeldBy(w) /\ JoinIsDue /\ ~(claim = "cancel" /\ ~canceledEntered)
  /\ joinAdmitted' = StartedSideAdmits
  /\ startedWorkAfterClaim' = (startedWorkAfterClaim \/ (StartedSideAdmits /\ claim # "none"))
  /\ commitAfterEnd' = (commitAfterEnd \/ (status # "running" /\ StartedSideAdmits))
  /\ pc' = [pc EXCEPT ![w] = "canceled"]
  /\ UNCHANGED <<runVars, passFailed, sawParked, park, claim, status, joinDone, joinFailed,
                 canceledEntered, wakes, branchRuns, joinRuns, canceledEntries,
                 terminalWrites, failures, claimWrites, canceledWorkAfterExit, policyCanceled>>

\* Entity Eligibility refuses the Join: the run claims an Exit before it.
ExitBeforeJoin(w) ==
  /\ pc[w] = "admit" /\ LeaseHeldBy(w) /\ JoinIsDue /\ ClaimIsFree
  /\ claim' = "exit" /\ claimWrites' = claimWrites + 1
  /\ commitAfterEnd' = (commitAfterEnd \/ status # "running")
  /\ pc' = [pc EXCEPT ![w] = "canceled"]
  /\ UNCHANGED <<runVars, passFailed, sawParked, park, status, joinAdmitted, joinDone, joinFailed,
                 canceledEntered, wakes, branchRuns, joinRuns, canceledEntries,
                 terminalWrites, failures, startedWorkAfterClaim, canceledWorkAfterExit,
                 policyCanceled>>

NothingToAdmit(w) ==
  /\ pc[w] = "admit" /\ LeaseHeldBy(w)
  /\ ~(claim = "cancel" /\ ~canceledEntered) /\ ~JoinIsDue
  /\ Advance(w, "canceled")

\* The Canceled side: Wait C, then the Outlet action below it. A Cancel claim
\* admits it, an Exit claim refuses it.
RunsOutlet == park["C"] = "woken" /\ CanceledSideAdmits

VisitCanceled(w) ==
  /\ pc[w] = "canceled" /\ LeaseHeldBy(w)
  /\ park' = [park EXCEPT !["C"] =
               IF ~canceledEntered THEN @ ELSE
               CASE @ = "unreached" -> IF CanceledSideAdmits THEN "open" ELSE "halted"
                 [] @ = "woken"     -> IF CanceledSideAdmits THEN "ran" ELSE "halted"
                 [] @ = "hwoken"    -> "halted"
                 [] OTHER           -> @]
  /\ branchRuns' = [branchRuns EXCEPT !["C"] = IF canceledEntered /\ RunsOutlet THEN @ + 1 ELSE @]
  /\ canceledWorkAfterExit' = (canceledWorkAfterExit \/ (canceledEntered /\ RunsOutlet /\ claim = "exit"))
  /\ commitAfterEnd' = (commitAfterEnd \/ (status # "running" /\ park' # park))
  /\ sawParked' = [sawParked EXCEPT ![w] = \E p \in Parks : park'[p] = "open"]
  /\ pc' = [pc EXCEPT ![w] = "run"]
  /\ UNCHANGED <<runVars, passFailed, claim, status, joinAdmitted, joinDone, joinFailed,
                 canceledEntered, wakes, joinRuns, canceledEntries, terminalWrites,
                 failures, claimWrites, startedWorkAfterClaim, policyCanceled>>

\* An admitted Join runs once. Work already admitted may finish after a claim.
JoinSucceeds(w) ==
  /\ pc[w] = "run" /\ LeaseHeldBy(w) /\ joinAdmitted /\ ~joinDone /\ ~joinFailed
  /\ joinDone' = TRUE /\ joinRuns' = joinRuns + 1
  /\ commitAfterEnd' = (commitAfterEnd \/ status # "running")
  /\ pc' = [pc EXCEPT ![w] = "release"]
  /\ UNCHANGED <<runVars, passFailed, sawParked, park, claim, status, joinAdmitted, joinFailed,
                 canceledEntered, wakes, branchRuns, canceledEntries, terminalWrites,
                 failures, claimWrites, startedWorkAfterClaim, canceledWorkAfterExit,
                 policyCanceled>>

\* "Retries": the Join's step body throws a retriable error and the pass ends.
JoinFails(w) ==
  /\ pc[w] = "run" /\ LeaseHeldBy(w) /\ joinAdmitted /\ ~joinDone /\ ~joinFailed
  /\ passFailed' = [passFailed EXCEPT ![w] = TRUE] /\ failures' = Sat(failures + 1)
  /\ pc' = [pc EXCEPT ![w] = "release"]
  /\ UNCHANGED <<runVars, sawParked, dataVars, wakes, branchRuns, joinRuns,
                 canceledEntries, terminalWrites, claimWrites, startedWorkAfterClaim,
                 canceledWorkAfterExit, commitAfterEnd, policyCanceled>>

NothingToRun(w) ==
  /\ pc[w] = "run" /\ LeaseHeldBy(w) /\ ~(joinAdmitted /\ ~joinDone /\ ~joinFailed)
  /\ Advance(w, "release")

-----------------------------------------------------------------------------
(* Design A, step 4: release. *)

\* The Join's retries ran out on this pass.
RetriesSpent(w) == passFailed[w] /\ attempt + 1 >= MaxAttempts

Release(w) ==
  /\ pc[w] = "release" /\ LeaseHeldBy(w)
  /\ holder' = 0 /\ pc' = [pc EXCEPT ![w] = "idle"]
  \* "Retries": a step whose retries ran out fails its node, and the run goes on.
  /\ joinFailed' = (joinFailed \/ RetriesSpent(w))
  /\ CASE claim = "exit" /\ \A p \in Parks : park[p] \notin Woken ->
            \* Exited: no Canceled outlet, and admitted work has finished.
            /\ status' = IF RunInFlight THEN "exited" ELSE status
            /\ sched' = "gone" /\ terminalWrites' = terminalWrites + 1
            /\ UNCHANGED attempt
       [] park["C"] = "ran" ->
            /\ status' = IF RunInFlight THEN "canceled" ELSE status
            /\ sched' = "gone" /\ terminalWrites' = terminalWrites + 1
            /\ UNCHANGED attempt
       [] joinDone /\ claim = "none" ->
            /\ status' = IF RunInFlight THEN "completed" ELSE status
            /\ sched' = "gone" /\ terminalWrites' = terminalWrites + 1
            /\ UNCHANGED attempt
       [] RetriesSpent(w) /\ FailedNodeEndsRun ->
            /\ status' = IF RunInFlight THEN "failed" ELSE status
            /\ sched' = "gone" /\ terminalWrites' = terminalWrites + 1
            /\ UNCHANGED attempt
       [] RetriesSpent(w) ->
            \* A claim still has work: the attempt counter starts over and the
            \* run is released as its Waits say.
            /\ attempt' = 0
            /\ sched' = IF \E p \in Parks : park[p] \in Woken THEN "queued"
                        ELSE IF \E p \in Parks : park[p] = "open" THEN "waiting"
                        ELSE "queued"
            /\ UNCHANGED <<status, terminalWrites>>
       [] passFailed[w] ->
            \* "Retries": queued with one more on the attempt counter.
            /\ sched' = "queued" /\ attempt' = Sat(attempt + 1)
            /\ UNCHANGED <<status, terminalWrites>>
       [] ReleaseReadsWaitRows /\ \E p \in Parks : park[p] \in Woken ->
            /\ sched' = "queued"
            /\ UNCHANGED <<attempt, status, terminalWrites>>
       [] \/ \E p \in Parks : park[p] = "open"
          \/ ~ReleaseReadsWaitRows /\ sawParked[w] ->
            /\ sched' = "waiting"
            /\ UNCHANGED <<attempt, status, terminalWrites>>
       [] OTHER ->
            /\ sched' = "queued"
            /\ UNCHANGED <<attempt, status, terminalWrites>>
  /\ UNCHANGED <<faults, passFailed, sawParked, park, claim, joinAdmitted, joinDone,
                 canceledEntered, wakes, branchRuns, joinRuns, canceledEntries, failures,
                 claimWrites, startedWorkAfterClaim, canceledWorkAfterExit,
                 commitAfterEnd, policyCanceled>>

-----------------------------------------------------------------------------
(* "Lease and liveness". Faults are bounded so a behaviour can end. *)

\* The lease runs out under a slow or dead worker: the sweep re-queues the row
\* with one more on the attempt counter, and owner_token is cleared.
LeaseExpires ==
  /\ sched = "leased" /\ faults < MaxFaults
  /\ sched' = "queued" /\ holder' = 0 /\ attempt' = Sat(attempt + 1)
  /\ faults' = faults + 1 /\ failures' = Sat(failures + 1)
  /\ UNCHANGED <<workerVars, dataVars, wakes, branchRuns, joinRuns, canceledEntries,
                 terminalWrites, claimWrites, startedWorkAfterClaim,
                 canceledWorkAfterExit, commitAfterEnd, policyCanceled>>

\* A worker process dies mid-pass. Its lease stays until it expires.
Crash(w) ==
  /\ pc[w] # "idle" /\ faults < MaxFaults
  /\ pc' = [pc EXCEPT ![w] = "idle"] /\ faults' = faults + 1
  /\ UNCHANGED <<sched, holder, attempt, passFailed, sawParked, dataVars, observers>>

\* The sweep that recovers a dead worker's lease. It is the same sweep as
\* LeaseExpires, and only counts as a fault when it interrupts a live pass.
SweepDeadLease ==
  /\ sched = "leased" /\ holder # 0 /\ pc[holder] = "idle"
  /\ sched' = "queued" /\ holder' = 0 /\ attempt' = Sat(attempt + 1)
  /\ failures' = Sat(failures + 1)
  /\ UNCHANGED <<faults, workerVars, dataVars, wakes, branchRuns, joinRuns,
                 canceledEntries, terminalWrites, claimWrites, startedWorkAfterClaim,
                 canceledWorkAfterExit, commitAfterEnd, policyCanceled>>

-----------------------------------------------------------------------------
(* "Resolving a park", "Cancellation", "Exit claim". The producer locks the     *)
(* schedule row first, so each producer write is one step against a release.   *)

Requeue == sched' = IF sched = "waiting" THEN "queued" ELSE sched

\* wakeWait: claim the wait row, record the wake, re-queue a sleeping run.
\* claimWaitState refuses a run that holds an Exit claim.
EventWake(p) ==
  /\ RunInFlight /\ claim # "exit" /\ WakeIsUnclaimed(p)
  /\ park' = [park EXCEPT ![p] = "woken"] /\ wakes' = [wakes EXCEPT ![p] = @ + 1]
  /\ Requeue
  /\ UNCHANGED <<holder, attempt, faults, workerVars, claim, status, joinAdmitted,
                 joinDone, joinFailed, canceledEntered, branchRuns, joinRuns, canceledEntries,
                 terminalWrites, failures, claimWrites, startedWorkAfterClaim,
                 canceledWorkAfterExit, commitAfterEnd, policyCanceled>>

\* A Cancel Event: write the claim, resolve every open Started-side park as a
\* cancel wake, and re-queue a sleeping run.
CancelEvent ==
  /\ RunInFlight /\ ClaimIsFree
  /\ claim' = "cancel" /\ claimWrites' = claimWrites + 1
  /\ park' = [p \in Parks |-> IF p \in Started /\ park[p] = "open" THEN "hwoken" ELSE park[p]]
  /\ wakes' = [p \in Parks |-> IF p \in Started /\ park[p] = "open" THEN wakes[p] + 1 ELSE wakes[p]]
  /\ Requeue
  /\ UNCHANGED <<holder, attempt, faults, workerVars, status, joinAdmitted, joinDone, joinFailed,
                 canceledEntered, branchRuns, joinRuns, canceledEntries, terminalWrites,
                 failures, startedWorkAfterClaim, canceledWorkAfterExit, commitAfterEnd,
                 policyCanceled>>

\* A policy cancel (the Runs view's cancel button, supersede, a refused enqueue):
\* terminal status, schedule row deleted, owner_token cleared, parks cancelled.
PolicyCancel ==
  /\ RunInFlight
  /\ status' = "canceled" /\ policyCanceled' = TRUE /\ terminalWrites' = terminalWrites + 1
  /\ sched' = "gone" /\ holder' = 0
  /\ park' = [p \in Parks |-> IF park[p] \in {"open", "woken", "hwoken"} THEN "cancelled" ELSE park[p]]
  /\ UNCHANGED <<attempt, faults, workerVars, claim, joinAdmitted, joinDone, joinFailed,
                 canceledEntered, wakes, branchRuns, joinRuns, canceledEntries, failures,
                 claimWrites, startedWorkAfterClaim, canceledWorkAfterExit, commitAfterEnd>>

\* The run ended and every worker has stopped.
Ended == sched = "gone" /\ \A w \in Workers : pc[w] = "idle" /\ UNCHANGED vars

\* Everything a worker does, which fairness keeps from stalling.
WorkerStep(w) ==
  \/ Claim(w) \/ ClaimWhenDue(w) \/ Fenced(w) \/ VisitStarted(w) \/ ExitBeforeBranch(w)
  \/ EnterCanceledOutlet(w) \/ AdmitJoin(w) \/ ExitBeforeJoin(w) \/ NothingToAdmit(w)
  \/ VisitCanceled(w) \/ JoinSucceeds(w) \/ JoinFails(w) \/ NothingToRun(w) \/ Release(w)

Next ==
  \/ \E w \in Workers : WorkerStep(w) \/ Crash(w)
  \/ \E p \in Parks : EventWake(p)
  \/ LeaseExpires \/ SweepDeadLease \/ CancelEvent \/ PolicyCancel \/ Ended

Spec == Init /\ [][Next]_vars

\* Workers keep working and dead leases are swept. Events, cancels, crashes and
\* expiries of live leases are free never to happen.
FairSpec == Spec /\ \A w \in Workers : WF_vars(WorkerStep(w)) /\ WF_vars(SweepDeadLease)

\* Keeps a mutated model finite. In the model as written every counter stays at
\* most 1 whenever its rule holds, so this bound only cuts states in which a
\* rule has already broken.
CountersBounded ==
  /\ \A p \in Parks : wakes[p] <= 2 /\ branchRuns[p] <= 2
  /\ joinRuns <= 2 /\ canceledEntries <= 2 /\ terminalWrites <= 2 /\ claimWrites <= 2

-----------------------------------------------------------------------------
(* Rules. Each is one sentence a reader of the design doc agrees to. *)

\* A run never sleeps while one of its Waits holds a wake nobody has acted on.
WokenBranchIsNeverStranded == sched = "waiting" => \A p \in Parks : park[p] \notin Woken

\* A sleeping run always has an open Wait whose deadline will wake it.
SleepingRunHasADeadline == sched = "waiting" => \E p \in Parks : park[p] = "open"

\* Each Wait is woken at most once: an Event, its timeout and a claim never both win.
EachWaitWokenOnce == \A p \in Parks : wakes[p] <= 1

\* The work below each Wait runs at most once, and the Outlet is that work for Wait C.
EachBranchRunsOnce == \A p \in Parks : branchRuns[p] <= 1

\* The Join runs at most once, and only after both Started-side branches ran.
JoinRunsOnceAfterBothBranches ==
  /\ joinRuns <= 1
  /\ joinRuns = 1 => \A p \in Started : branchRuns[p] = 1

\* The Canceled outlet is entered at most once, and only after a Cancel Event claimed the run.
CanceledOutletEnteredOnceOnCancel ==
  /\ canceledEntries <= 1
  /\ canceledEntries = 1 => claim = "cancel"

\* The first claim wins: a run's claim is written at most once.
OneClaimWins == claimWrites <= 1

\* No Started-side work is admitted after a Cancel or Exit claim.
NoStartedWorkAfterAClaim == ~startedWorkAfterClaim

\* An Exit claim also refuses the Canceled side.
NoCanceledWorkAfterExit == ~canceledWorkAfterExit

\* Nothing commits after the run has ended.
NothingCommitsAfterTheRunEnds == ~commitAfterEnd

\* The run's terminal record is written once.
OneTerminalRecord == terminalWrites <= 1

\* A run that has ended leaves no Wait parked for an Event to find.
NoWaitLeftOpenAfterTheRunEnds == status # "running" => \A p \in Parks : park[p] # "open"

\* An Exit halts every Wait of the run: an exited run leaves none parked.
ExitHaltsEveryWait == status = "exited" => \A p \in Parks : park[p] # "open"

\* Each ending matches the work behind it.
EndMatchesWork ==
  /\ status = "completed" => joinDone /\ claim = "none"
  /\ (status = "canceled" /\ ~policyCanceled) => park["C"] = "ran" /\ claim = "cancel"
  /\ status = "exited" => claim = "exit" /\ branchRuns["C"] = 0 /\ ~joinDone
  /\ status = "failed" => joinFailed /\ claim = "none"

\* A Cancel Event's claim always reaches its outlet: a run it claimed ends only
\* after the Outlet ran, unless a policy cancel ended it first.
CancelClaimRunsItsOutlet ==
  (status # "running" /\ claim = "cancel" /\ ~policyCanceled) => park["C"] = "ran"

\* A run is marked failed only after its retries were spent on failures.
FailedOnlyAfterRetriesSpent == status = "failed" => failures >= MaxAttempts

\* A leased schedule row has a lease holder, and no other row does.
LeaseHasAHolder == (sched = "leased") = (holder # 0)

-----------------------------------------------------------------------------
(* Liveness, checked under FairSpec. *)

\* Every run ends.
EveryRunEnds == <>(status # "running")

\* Every wake is acted on: a woken Wait is run past, halted, or cancelled, or the run ends.
EveryWakeIsActedOn ==
  \A p \in Parks : (park[p] \in Woken) ~> (park[p] \notin Woken \/ status # "running")

-----------------------------------------------------------------------------
(* Reachability. check.sh requires each of these to be reachable, so a model *)
(* that silently disables an action cannot pass by checking nothing.         *)

ReachCompleted        == status = "completed"
ReachCanceledByEvent  == status = "canceled" /\ ~policyCanceled /\ park["C"] = "ran"
ReachExitedAtBranch   == status = "exited" /\ \E p \in Started : park[p] = "halted" /\ branchRuns[p] = 0
ReachExitedAtJoin     == status = "exited" /\ \A p \in Started : park[p] = "ran"
ReachFailed           == status = "failed"
ReachRetriedJoin      == joinDone /\ failures >= 1
ReachCanceledAfterJoinFailed == status = "canceled" /\ joinFailed /\ park["C"] = "ran"
ReachCanceledWaitParks == park["C"] = "open" /\ sched = "waiting"
ReachTimeoutWake      == \E p \in Parks : park[p] = "woken" /\ sched = "leased" /\ wakes[p] = 1
ReachStaleWorkerFenced == \E w \in Workers : pc[w] # "idle" /\ holder # w /\ sched = "leased"
=============================================================================
