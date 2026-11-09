------------------------------- MODULE Handler -------------------------------
(***************************************************************************)
(* The steps inside one node's handler (ADR-0009), under the executor      *)
(* proposed in docs/internal/plans/separate-event-intake-from-durable-    *)
(* execution.md ("The runtime", run(step, fn); "Fencing store writes";     *)
(* "Retries").                                                             *)
(*                                                                         *)
(* The node opens its log row in step "log-open", reads a value from       *)
(* vendor A in step "read", sends it to vendor B in step "send" with an    *)
(* idempotency key built from the execution, node and step ids, and closes *)
(* its log row in step "log-close". Vendor A may answer differently each   *)
(* time it is asked. Vendor B applies a key once. The send may succeed,    *)
(* may be refused (a StepFailure, stored as a value so the node fails     *)
(* once), or may throw a retriable error, which ends the pass for a retry. *)
(*                                                                         *)
(* A pass loads the step memo when it claims the run. run(step, fn) runs   *)
(* fn and then writes the memo row in a transaction that checks the lease *)
(* first. A store write inside fn commits in its own transaction, so a     *)
(* crash or a lost lease between the store write and the memo write runs   *)
(* fn again on the next pass, and a slow worker whose lease expired can    *)
(* still reach a store write or a vendor call.                             *)
(*                                                                         *)
(* The log open is an idempotent step (runIdempotent) and the log close a  *)
(* direct store write; neither writes a memo row. Both run on every pass,  *)
(* and the pass reads the node's log row when it claims the run and skips  *)
(* a log write that would change nothing. The open's insert may throw a    *)
(* retriable error, counted against the open's own step; a later success   *)
(* over those failures marks the open's memo row succeeded. The heartbeat  *)
(* records the step its holder is running, which an expired lease counts   *)
(* against, and the open is never that step.                               *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Workers, MaxAttempts, MaxFaults

Values == {"x", "y"}
Steps == {"open", "read", "send"}

VARIABLES
  sched,        \* the run's schedule row: "queued" | "leased" | "gone"
  holder,       \* owner_token, 0 for none
  attempt,      \* failures and expired leases of the whole run, saturating past MaxAttempts
  faults,
  pc,           \* each worker: "idle" | "open" | "read" | "readMemo" | "send"
                \*   | "sendMemo" | "close" | "release"
  seenOpen,     \* each worker: whether its pass's read found the node's log row
  seenRead,     \* each worker: the read memo its pass loaded, "none" if absent
  seenSend,     \* each worker: the send memo its pass loaded: "none" | "ok" | "refused"
  seenClose,    \* each worker: whether its pass's read found the log row closed
  openOut,      \* each worker: how this pass's log open went: "ok" | "threw" | "refused"
  readVal,      \* each worker: the value this pass read
  readOut,      \* each worker: whether this pass's read step "ok" or "threw"
  sendOut,      \* each worker: what this pass's send came back with: "ok" | "refused" | "threw"
  memoRead,     \* the read step's memo row: "none" or the value
  memoSend,     \* the send step's memo row: "none" | "ok" | "refused"
  logRows,      \* log rows the node has, saturating at 2
  openRows,     \* of those, rows still running
  logCloses,    \* close writes applied to a log row, saturating at 2
  closedOk,     \* a close that applied wrote the row as a success
  openSettled,  \* the open's memo row was marked succeeded over its failures
  beat,         \* the step the schedule row names as running: "none" | "open" | "read" | "send"
  node,         \* the node's outcome: "running" | "succeeded" | "failed"
  applied,      \* vendor B: the value it applied for the key, "none" if none
  applies,      \* vendor B: how many sends it applied
  output,       \* the node's output, "none" until it succeeds
  refusalRetried, \* a refused send was retried as if it were a transient error
  sentAfterRefusal, \* the lease holder sent again after a refusal was recorded
  outcomeChanged, \* the node's outcome was rewritten after it ended
  failures      \* each step: its retriable failures and the expired leases it was running under

vars == <<sched, holder, attempt, faults, pc, seenOpen, seenRead, seenSend, seenClose,
          openOut, readVal, readOut, sendOut, memoRead, memoSend, logRows, openRows,
          logCloses, closedOk, openSettled, beat, node, applied, applies, output,
          refusalRetried, sentAfterRefusal, outcomeChanged, failures>>

Sat(n) == IF n > MaxAttempts + 1 THEN MaxAttempts + 1 ELSE n
Sat2(n) == IF n > 2 THEN 2 ELSE n

\* The guards the design depends on.
LeaseHeldBy(w) == holder = w                 \* the memo write checks owner_token
StoreWriteIsFenced == TRUE                   \* every store write checks owner_token
LogIdIsTheStepId == TRUE                     \* log-open inserts a row id derived from the execution and node, on conflict do nothing
CloseIsConditional == TRUE                   \* log-close updates only a row still running or closed as error
PassReadsLogRows == TRUE                     \* the pass reads the node's log row when it opens
SuccessReconcilesFailures == TRUE            \* a log open that succeeds over a failing memo row marks it succeeded
IdempotentStepIsNeverRunning == TRUE         \* the heartbeat never records the log open as the running step
SendCarriesAKey == TRUE                      \* callExternal passes an idempotency key
ReadIsMemoized == TRUE                       \* the handler wraps the read in step.run
RefusalIsAValue == TRUE                      \* a StepFailure is stored, not thrown
AttemptsArePerStep == TRUE                   \* each step's memo row counts that step's own failures

\* A store write this worker may commit: the lease holder's, or any worker's
\* when store writes are not fenced.
MayWrite(w) == LeaseHeldBy(w) \/ ~StoreWriteIsFenced

Init ==
  /\ sched = "queued" /\ holder = 0 /\ attempt = 0 /\ faults = 0
  /\ pc = [w \in Workers |-> "idle"]
  /\ seenOpen = [w \in Workers |-> FALSE] /\ seenClose = [w \in Workers |-> FALSE]
  /\ openOut = [w \in Workers |-> "ok"]
  /\ seenRead = [w \in Workers |-> "none"] /\ seenSend = [w \in Workers |-> "none"]
  /\ readVal = [w \in Workers |-> "x"] /\ sendOut = [w \in Workers |-> "ok"]
  /\ memoRead = "none" /\ memoSend = "none"
  /\ logRows = 0 /\ openRows = 0 /\ logCloses = 0 /\ closedOk = FALSE
  /\ openSettled = FALSE /\ beat = "none" /\ node = "running"
  /\ applied = "none" /\ applies = 0 /\ output = "none" /\ refusalRetried = FALSE
  /\ sentAfterRefusal = FALSE /\ outcomeChanged = FALSE
  /\ failures = [st \in Steps |-> 0] /\ readOut = [w \in Workers |-> "ok"]

seenVars == <<seenOpen, seenRead, seenSend, seenClose>>
workerVars == <<pc, seenVars, openOut, readVal, readOut, sendOut>>
memoVars == <<memoRead, memoSend, openSettled>>
logVars == <<logRows, openRows, logCloses, closedOk>>
nodeVars == <<node, output, refusalRetried, outcomeChanged, failures>>
vendorVars == <<applied, applies, sentAfterRefusal>>
leaseVars == <<sched, holder, attempt, faults, beat>>

Go(w, s) == pc' = [pc EXCEPT ![w] = s]

-----------------------------------------------------------------------------

Claim(w) ==
  /\ sched = "queued" /\ pc[w] = "idle"
  /\ sched' = "leased" /\ holder' = w /\ beat' = "none"
  \* The pass reads the node's log row when it opens, before any step runs.
  \* The read finds the row by the id the open derives from the node, and
  \* skips only a close the conditional close would refuse.
  /\ seenOpen' = [seenOpen EXCEPT ![w] = PassReadsLogRows /\ LogIdIsTheStepId /\ logRows > 0]
  /\ seenRead' = [seenRead EXCEPT ![w] = IF ReadIsMemoized THEN memoRead ELSE "none"]
  /\ seenSend' = [seenSend EXCEPT ![w] = memoSend]
  /\ seenClose' = [seenClose EXCEPT ![w] =
                     PassReadsLogRows /\ CloseIsConditional /\ logRows > 0 /\ openRows = 0]
  /\ readOut' = [readOut EXCEPT ![w] = "ok"] /\ sendOut' = [sendOut EXCEPT ![w] = "ok"]
  /\ openOut' = [openOut EXCEPT ![w] = "ok"]
  /\ Go(w, "open")
  /\ UNCHANGED <<attempt, faults, readVal, memoVars, logVars, nodeVars, vendorVars>>

\* Whether a step's memo row records a success, after which a failure of the
\* step is no longer counted (countStepFailure leaves a succeeded row alone).
Settled(st) ==
  CASE st = "open" -> openSettled
    [] st = "read" -> memoRead # "none"
    [] st = "send" -> memoSend # "none"

\* The log open succeeded. Over a failing memo row it marks the row
\* succeeded, keeping the count, in a write fenced on the lease that also
\* clears the schedule row's running step when it names the open.
OpenSucceeded(w) ==
  IF SuccessReconcilesFailures /\ failures["open"] > 0 /\ ~openSettled
    THEN IF LeaseHeldBy(w)
           THEN /\ openSettled' = TRUE /\ Go(w, "read")
                /\ beat' = IF beat = "open" THEN "none" ELSE beat
           ELSE Go(w, "idle") /\ UNCHANGED <<openSettled, beat>>
    ELSE Go(w, "read") /\ UNCHANGED <<openSettled, beat>>

\* The log-open step. A step whose retries are spent is refused before it
\* runs. A row the pass's read found skips the insert; otherwise insert the
\* node's log row, which may throw a retriable error that ends the pass.
Open(w) ==
  /\ pc[w] = "open"
  /\ IF failures["open"] >= MaxAttempts /\ ~openSettled
       THEN /\ openOut' = [openOut EXCEPT ![w] = "refused"] /\ Go(w, "release")
            /\ UNCHANGED <<logVars, openSettled, beat>>
       ELSE IF seenOpen[w]
       THEN OpenSucceeded(w) /\ UNCHANGED <<openOut, logVars>>
       ELSE IF ~MayWrite(w)
       THEN Go(w, "idle") /\ UNCHANGED <<openOut, logVars, openSettled, beat>>
       ELSE \/ /\ OpenSucceeded(w) /\ UNCHANGED openOut
               /\ IF LogIdIsTheStepId /\ logRows > 0
                    THEN UNCHANGED logVars
                    ELSE /\ logRows' = Sat2(logRows + 1) /\ openRows' = Sat2(openRows + 1)
                         /\ UNCHANGED <<logCloses, closedOk>>
            \/ /\ openOut' = [openOut EXCEPT ![w] = "threw"] /\ Go(w, "release")
               /\ UNCHANGED <<logVars, openSettled, beat>>
  /\ UNCHANGED <<sched, holder, attempt, faults, seenVars, readVal, readOut, sendOut,
                 memoRead, memoSend, nodeVars, vendorVars>>

\* The read step: a memo hit returns the recorded value; otherwise ask vendor A,
\* which may answer either value or throw a retriable error that ends the pass.
Read(w) ==
  /\ pc[w] = "read"
  /\ IF seenRead[w] # "none"
       THEN /\ readVal' = [readVal EXCEPT ![w] = seenRead[w]] /\ Go(w, "send")
            /\ UNCHANGED readOut
       ELSE \/ \E v \in Values : /\ readVal' = [readVal EXCEPT ![w] = v] /\ Go(w, "readMemo")
                                 /\ UNCHANGED readOut
            \/ /\ readOut' = [readOut EXCEPT ![w] = "threw"] /\ Go(w, "release")
               /\ UNCHANGED readVal
  /\ UNCHANGED <<leaseVars, seenVars, openOut, sendOut, memoVars, logVars, nodeVars, vendorVars>>

WriteMemo(old, new) == IF old = "none" THEN new ELSE old

\* The running step a memo write for st leaves on the schedule row: cleared
\* when the row names st, kept otherwise (runningAfterMemo).
BeatAfterMemo(st) == IF beat = st THEN "none" ELSE beat

ReadMemo(w) ==
  /\ pc[w] = "readMemo"
  /\ IF LeaseHeldBy(w) /\ ReadIsMemoized
       THEN /\ memoRead' = WriteMemo(memoRead, readVal[w]) /\ Go(w, "send")
            /\ beat' = BeatAfterMemo("read")
       ELSE IF ~ReadIsMemoized /\ LeaseHeldBy(w)
       THEN /\ Go(w, "send") /\ UNCHANGED <<memoRead, beat>>
       ELSE /\ Go(w, "idle") /\ UNCHANGED <<memoRead, beat>>
  /\ UNCHANGED <<sched, holder, attempt, faults, seenVars, openOut, readVal, readOut,
                 sendOut, memoSend, openSettled, logVars, nodeVars, vendorVars>>

\* The send step: a memo hit returns the recorded outcome; otherwise call vendor B.
Send(w) ==
  /\ pc[w] = "send"
  /\ IF seenSend[w] # "none"
       THEN /\ sendOut' = [sendOut EXCEPT ![w] = seenSend[w]] /\ Go(w, "close")
            /\ UNCHANGED vendorVars
       ELSE \E out \in {"ok", "refused", "threw"} :
              /\ sendOut' = [sendOut EXCEPT ![w] = out]
              /\ sentAfterRefusal' = (sentAfterRefusal \/ (memoSend = "refused" /\ LeaseHeldBy(w)))
              /\ IF out = "ok"
                   THEN /\ applied' = IF applied = "none" \/ ~SendCarriesAKey THEN readVal[w] ELSE applied
                        /\ applies' = IF applied = "none" \/ ~SendCarriesAKey THEN applies + 1 ELSE applies
                   ELSE UNCHANGED <<applied, applies>>
              /\ Go(w, IF out = "threw" \/ (out = "refused" /\ ~RefusalIsAValue) THEN "release" ELSE "sendMemo")
  /\ UNCHANGED <<leaseVars, seenVars, openOut, readVal, readOut, memoVars, logVars, nodeVars>>

SendMemo(w) ==
  /\ pc[w] = "sendMemo"
  /\ IF LeaseHeldBy(w)
       THEN /\ memoSend' = WriteMemo(memoSend, sendOut[w]) /\ Go(w, "close")
            /\ beat' = BeatAfterMemo("send")
       ELSE /\ Go(w, "idle") /\ UNCHANGED <<memoSend, beat>>
  /\ UNCHANGED <<sched, holder, attempt, faults, seenVars, openOut, readVal, readOut,
                 sendOut, memoRead, openSettled, logVars, nodeVars, vendorVars>>

\* The log close, a direct store write and no step: a closed row the pass's
\* read found skips it; otherwise close the log row, as a success when the
\* send went through. It writes no memo row and counts no failure.
Close(w) ==
  /\ pc[w] = "close"
  /\ IF seenClose[w]
       THEN Go(w, "release") /\ UNCHANGED logVars
       ELSE IF ~MayWrite(w)
       THEN Go(w, "idle") /\ UNCHANGED logVars
       ELSE /\ Go(w, "release") /\ UNCHANGED logRows
            /\ IF CloseIsConditional /\ openRows = 0
                 THEN UNCHANGED <<openRows, logCloses, closedOk>>
                 ELSE /\ openRows' = IF openRows > 0 THEN openRows - 1 ELSE 0
                      /\ logCloses' = Sat2(logCloses + 1)
                      /\ closedOk' = (closedOk \/ sendOut[w] = "ok")
  /\ UNCHANGED <<leaseVars, seenVars, openOut, readVal, readOut, sendOut, memoVars, nodeVars, vendorVars>>

\* The node's output is the value the send carried, as the memo records it.
RecordedBy(w) == IF ReadIsMemoized THEN memoRead ELSE readVal[w]

\* The step this pass's failure belongs to, "none" when no step failed.
FailingStep(w) ==
  IF openOut[w] = "threw" THEN "open"
  ELSE IF readOut[w] = "threw" THEN "read"
  ELSE IF sendOut[w] \in {"threw", "refused"} THEN "send"
  ELSE "none"

\* The failures counted against a step: its own, or the whole run's when
\* attempts are counted per run.
FailuresOf(st) == IF AttemptsArePerStep THEN failures[st] ELSE attempt

\* This pass's step failed, and that step has no retries left. A step whose
\* memo row already records a success has its failure counted by nobody.
RetriesSpent(w) ==
  /\ FailingStep(w) # "none" /\ ~Settled(FailingStep(w))
  /\ FailuresOf(FailingStep(w)) + 1 >= MaxAttempts

CountFailure(st) == IF Settled(st) THEN failures ELSE [failures EXCEPT ![st] = Sat(@ + 1)]

\* The outcome a pass ending here writes for the node, "none" when it writes none.
Outcome(w) ==
  CASE openOut[w] = "refused" -> "failed"
    [] memoSend = "ok" -> "succeeded"
    [] memoSend = "refused" -> "failed"
    [] RetriesSpent(w) -> "failed"
    [] OTHER -> "none"

\* Whether writing outcome o rewrites an outcome that has already ended.
Rewrites(o) == node # "running" /\ o # "none" /\ o # node

\* The release frees the schedule row, which only the lease holder can do. The
\* node's outcome is a store write, which a stale worker commits too when store
\* writes are not fenced.
Release(w) ==
  /\ pc[w] = "release"
  /\ IF ~LeaseHeldBy(w)
       THEN /\ Go(w, "idle")
            /\ IF MayWrite(w) /\ Outcome(w) # "none"
                 THEN /\ node' = Outcome(w)
                      /\ output' = IF Outcome(w) = "succeeded" THEN RecordedBy(w) ELSE output
                      /\ outcomeChanged' = (outcomeChanged \/ Rewrites(Outcome(w)))
                 ELSE UNCHANGED <<node, output, outcomeChanged>>
            /\ UNCHANGED <<sched, holder, attempt, refusalRetried, failures>>
       ELSE IF openOut[w] = "refused"
       \* A refused log open fails the node whatever its steps recorded.
       THEN /\ holder' = 0 /\ Go(w, "idle") /\ node' = "failed" /\ sched' = "gone"
            /\ outcomeChanged' = (outcomeChanged \/ Rewrites("failed"))
            /\ UNCHANGED <<attempt, output, failures, refusalRetried>>
       ELSE /\ holder' = 0 /\ Go(w, "idle")
            /\ outcomeChanged' = (outcomeChanged \/ Rewrites(Outcome(w)))
            /\ CASE memoSend = "ok" ->
                      /\ node' = "succeeded" /\ sched' = "gone" /\ output' = RecordedBy(w)
                      /\ UNCHANGED <<attempt, failures, refusalRetried>>
                 [] memoSend = "refused" ->
                      /\ node' = "failed" /\ sched' = "gone"
                      /\ UNCHANGED <<attempt, output, failures, refusalRetried>>
                 [] RetriesSpent(w) ->
                      /\ node' = "failed" /\ sched' = "gone" /\ failures' = CountFailure(FailingStep(w))
                      /\ refusalRetried' = (refusalRetried \/ sendOut[w] = "refused")
                      /\ UNCHANGED <<attempt, output>>
                 [] FailingStep(w) # "none" ->
                      /\ sched' = "queued" /\ attempt' = Sat(attempt + 1)
                      /\ failures' = CountFailure(FailingStep(w))
                      /\ refusalRetried' = (refusalRetried \/ sendOut[w] = "refused")
                      /\ UNCHANGED <<node, output>>
                 [] OTHER ->
                      /\ sched' = "queued" /\ UNCHANGED <<attempt, node, output, failures, refusalRetried>>
  \* The release clears the running step, and a stale worker writes no release.
  /\ beat' = IF LeaseHeldBy(w) THEN "none" ELSE beat
  /\ UNCHANGED <<faults, seenVars, openOut, readVal, readOut, sendOut, memoVars, logVars, vendorVars>>

-----------------------------------------------------------------------------

\* The step a worker is running in its own memory, "none" between steps. The
\* log open is a short store write and never the running step.
RunningStepOf(w) ==
  IF pc[w] = "open" /\ ~IdempotentStepIsNeverRunning THEN "open"
  ELSE IF pc[w] \in {"read", "readMemo"} THEN "read"
  ELSE IF pc[w] \in {"send", "sendMemo"} THEN "send"
  ELSE "none"

\* The holder's heartbeat records the step it is running on the schedule row.
Heartbeat ==
  /\ sched = "leased" /\ holder # 0 /\ pc[holder] # "idle"
  /\ beat' = RunningStepOf(holder)
  /\ UNCHANGED <<sched, holder, attempt, faults, workerVars, memoVars, logVars,
                 nodeVars, vendorVars>>

\* A failure the claim's sweep counts: against the step the schedule row
\* names as running, and none when it names none.
SweptFailures == IF beat = "none" THEN failures ELSE CountFailure(beat)

\* An expired lease counts against the step the schedule row names.
LeaseExpires ==
  /\ sched = "leased" /\ faults < MaxFaults
  /\ sched' = "queued" /\ holder' = 0 /\ attempt' = Sat(attempt + 1)
  /\ faults' = faults + 1 /\ failures' = SweptFailures /\ beat' = "none"
  /\ UNCHANGED <<workerVars, memoVars, logVars, node, output, refusalRetried,
                 outcomeChanged, vendorVars>>

Crash(w) ==
  /\ pc[w] # "idle" /\ faults < MaxFaults
  /\ Go(w, "idle") /\ faults' = faults + 1
  /\ UNCHANGED <<sched, holder, attempt, beat, seenVars, openOut, readVal, readOut, sendOut,
                 memoVars, logVars, nodeVars, vendorVars>>

\* A dead worker's lease is swept, counting against the step its row names.
SweepDeadLease ==
  /\ sched = "leased" /\ holder # 0 /\ pc[holder] = "idle"
  /\ sched' = "queued" /\ holder' = 0 /\ attempt' = Sat(attempt + 1)
  /\ failures' = SweptFailures /\ beat' = "none"
  /\ UNCHANGED <<faults, workerVars, memoVars, logVars, node, output, refusalRetried,
                 outcomeChanged, vendorVars>>

Ended == sched = "gone" /\ \A w \in Workers : pc[w] = "idle" /\ UNCHANGED vars

WorkerStep(w) ==
  \/ Claim(w) \/ Open(w) \/ Read(w) \/ ReadMemo(w) \/ Send(w)
  \/ SendMemo(w) \/ Close(w) \/ Release(w)

Next ==
  \/ \E w \in Workers : WorkerStep(w) \/ Crash(w)
  \/ Heartbeat \/ LeaseExpires \/ SweepDeadLease \/ Ended

Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ \A w \in Workers : WF_vars(WorkerStep(w)) /\ WF_vars(SweepDeadLease)

CountersBounded == applies <= 2

-----------------------------------------------------------------------------
(* Rules. *)

\* Vendor B applies the send once, however many times the step runs.
WriteAppliedOnce == applies <= 1

\* What vendor B applied is the value the node records as its output.
AppliedWriteMatchesTheOutput == (node = "succeeded" /\ applied # "none") => applied = output

\* A refused call fails the node once: it is never retried as a transient error,
\* and no pass holding the lease sends again after the refusal is recorded. A
\* worker that has lost its lease may still send once more, which the vendor's
\* idempotency key absorbs.
RefusalFailsTheNodeOnce == ~refusalRetried /\ ~sentAfterRefusal

\* The node fails only on a refusal, or after one of its steps spent that
\* step's own retries.
FailedOnlyOnRefusalOrSpentRetries ==
  node = "failed" => (memoSend = "refused" \/ \E st \in Steps : failures[st] >= MaxAttempts)

\* The node has one log row, however many passes open it.
OneLogRowPerNode == logRows <= 1

\* The node's log row is closed once, however many passes close it.
LogClosedOnce == logCloses <= 1

\* Once the node has succeeded or failed, nothing rewrites that outcome.
NodeOutcomeIsFinal == ~outcomeChanged

\* A step reads as retrying: it has counted failures and no success since.
Retrying == \E st \in Steps : failures[st] > 0 /\ ~Settled(st)

\* Once the node's log row is closed as a success, the node is never failed
\* or refused afterwards, and none of its steps reads as retrying.
FinishedNodeNeverRefused == closedOk => (node # "failed" /\ ~Retrying)

\* The node ends.
NodeEnds == <>(node # "running")

ReachSentTwice      == applies = 1 /\ \E w \in Workers : pc[w] = "send" /\ seenSend[w] = "none" /\ memoSend = "ok"
ReachRefused        == node = "failed" /\ memoSend = "refused"
ReachRetriedThenOk  == node = "succeeded" /\ failures["send"] >= 1
ReachReadRetried    == node = "succeeded" /\ failures["read"] >= 1 /\ memoRead # "none"
ReachOpenRetried    == node = "succeeded" /\ failures["open"] >= 1 /\ openSettled
ReachStaleRead      == \E w \in Workers : pc[w] = "readMemo" /\ holder # w /\ memoRead # "none"
ReachOpenedTwice    == logRows = 1 /\ \E w \in Workers : pc[w] = "open" /\ LeaseHeldBy(w)
ReachClosedTwice    == logCloses = 1 /\ \E w \in Workers : pc[w] = "close" /\ LeaseHeldBy(w)
ReachStaleRelease   == node # "running" /\ \E w \in Workers : pc[w] = "release" /\ ~LeaseHeldBy(w)
=============================================================================
