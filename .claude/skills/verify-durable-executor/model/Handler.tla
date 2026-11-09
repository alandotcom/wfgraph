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
(* The two log steps write no memo row (runIdempotent): they run on every *)
(* pass, and the pass reads the node's log row when it claims the run and *)
(* skips a log write that would change nothing.                            *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Workers, MaxAttempts, MaxFaults

Values == {"x", "y"}
Steps == {"read", "send"}

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
  readVal,      \* each worker: the value this pass read
  readOut,      \* each worker: whether this pass's read step "ok" or "threw"
  sendOut,      \* each worker: what this pass's send came back with: "ok" | "refused" | "threw"
  memoRead,     \* the read step's memo row: "none" or the value
  memoSend,     \* the send step's memo row: "none" | "ok" | "refused"
  logRows,      \* log rows the node has, saturating at 2
  openRows,     \* of those, rows still running
  logCloses,    \* close writes applied to a log row, saturating at 2
  node,         \* the node's outcome: "running" | "succeeded" | "failed"
  applied,      \* vendor B: the value it applied for the key, "none" if none
  applies,      \* vendor B: how many sends it applied
  output,       \* the node's output, "none" until it succeeds
  refusalRetried, \* a refused send was retried as if it were a transient error
  sentAfterRefusal, \* the lease holder sent again after a refusal was recorded
  outcomeChanged, \* the node's outcome was rewritten after it ended
  failures      \* each step: its retriable failures and the expired leases it was running under

vars == <<sched, holder, attempt, faults, pc, seenOpen, seenRead, seenSend, seenClose,
          readVal, readOut, sendOut, memoRead, memoSend, logRows, openRows,
          logCloses, node, applied, applies, output, refusalRetried, sentAfterRefusal,
          outcomeChanged, failures>>

Sat(n) == IF n > MaxAttempts + 1 THEN MaxAttempts + 1 ELSE n
Sat2(n) == IF n > 2 THEN 2 ELSE n

\* The guards the design depends on.
LeaseHeldBy(w) == holder = w                 \* the memo write checks owner_token
StoreWriteIsFenced == TRUE                   \* every store write checks owner_token
LogIdIsTheStepId == TRUE                     \* log-open inserts a row id derived from the execution and node, on conflict do nothing
CloseIsConditional == TRUE                   \* log-close updates only a row still running or closed as error
PassReadsLogRows == TRUE                     \* the pass reads the node's log row on its first log write
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
  /\ seenRead = [w \in Workers |-> "none"] /\ seenSend = [w \in Workers |-> "none"]
  /\ readVal = [w \in Workers |-> "x"] /\ sendOut = [w \in Workers |-> "ok"]
  /\ memoRead = "none" /\ memoSend = "none"
  /\ logRows = 0 /\ openRows = 0 /\ logCloses = 0 /\ node = "running"
  /\ applied = "none" /\ applies = 0 /\ output = "none" /\ refusalRetried = FALSE
  /\ sentAfterRefusal = FALSE /\ outcomeChanged = FALSE
  /\ failures = [st \in Steps |-> 0] /\ readOut = [w \in Workers |-> "ok"]

seenVars == <<seenOpen, seenRead, seenSend, seenClose>>
workerVars == <<pc, seenVars, readVal, readOut, sendOut>>
memoVars == <<memoRead, memoSend>>
logVars == <<logRows, openRows, logCloses>>
nodeVars == <<node, output, refusalRetried, outcomeChanged, failures>>
vendorVars == <<applied, applies, sentAfterRefusal>>
leaseVars == <<sched, holder, attempt, faults>>

Go(w, s) == pc' = [pc EXCEPT ![w] = s]

-----------------------------------------------------------------------------

Claim(w) ==
  /\ sched = "queued" /\ pc[w] = "idle"
  /\ sched' = "leased" /\ holder' = w
  \* The pass reads the node's log row. The code reads it on the pass's first
  \* log write, and only the lease holder writes the row before then. The read
  \* finds the row by the id the open derives from the node, and skips only a
  \* close the conditional close would refuse.
  /\ seenOpen' = [seenOpen EXCEPT ![w] = PassReadsLogRows /\ LogIdIsTheStepId /\ logRows > 0]
  /\ seenRead' = [seenRead EXCEPT ![w] = IF ReadIsMemoized THEN memoRead ELSE "none"]
  /\ seenSend' = [seenSend EXCEPT ![w] = memoSend]
  /\ seenClose' = [seenClose EXCEPT ![w] =
                     PassReadsLogRows /\ CloseIsConditional /\ logRows > 0 /\ openRows = 0]
  /\ readOut' = [readOut EXCEPT ![w] = "ok"] /\ sendOut' = [sendOut EXCEPT ![w] = "ok"]
  /\ Go(w, "open")
  /\ UNCHANGED <<attempt, faults, readVal, memoVars, logVars, nodeVars, vendorVars>>

\* The log-open step: a row the pass's read found skips it; otherwise insert
\* the node's log row. It writes no memo row.
Open(w) ==
  /\ pc[w] = "open"
  /\ IF seenOpen[w]
       THEN Go(w, "read") /\ UNCHANGED logVars
       ELSE IF ~MayWrite(w)
       THEN Go(w, "idle") /\ UNCHANGED logVars
       ELSE /\ Go(w, "read")
            /\ IF LogIdIsTheStepId /\ logRows > 0
                 THEN UNCHANGED logVars
                 ELSE /\ logRows' = Sat2(logRows + 1) /\ openRows' = Sat2(openRows + 1)
                      /\ UNCHANGED logCloses
  /\ UNCHANGED <<leaseVars, seenVars, readVal, readOut, sendOut, memoVars, nodeVars, vendorVars>>

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
  /\ UNCHANGED <<leaseVars, seenVars, sendOut, memoVars, logVars, nodeVars, vendorVars>>

WriteMemo(old, new) == IF old = "none" THEN new ELSE old

ReadMemo(w) ==
  /\ pc[w] = "readMemo"
  /\ IF LeaseHeldBy(w) /\ ReadIsMemoized
       THEN /\ memoRead' = WriteMemo(memoRead, readVal[w]) /\ Go(w, "send")
       ELSE IF ~ReadIsMemoized /\ LeaseHeldBy(w)
       THEN /\ Go(w, "send") /\ UNCHANGED memoRead
       ELSE /\ Go(w, "idle") /\ UNCHANGED memoRead
  /\ UNCHANGED <<leaseVars, seenVars, readVal, readOut, sendOut, memoSend,
                 logVars, nodeVars, vendorVars>>

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
  /\ UNCHANGED <<leaseVars, seenVars, readVal, readOut, memoVars, logVars, nodeVars>>

SendMemo(w) ==
  /\ pc[w] = "sendMemo"
  /\ IF LeaseHeldBy(w)
       THEN /\ memoSend' = WriteMemo(memoSend, sendOut[w]) /\ Go(w, "close")
       ELSE /\ Go(w, "idle") /\ UNCHANGED memoSend
  /\ UNCHANGED <<leaseVars, seenVars, readVal, readOut, sendOut, memoRead,
                 logVars, nodeVars, vendorVars>>

\* The log-close step: a closed row the pass's read found skips it; otherwise
\* close the log row. It writes no memo row.
Close(w) ==
  /\ pc[w] = "close"
  /\ IF seenClose[w]
       THEN Go(w, "release") /\ UNCHANGED logVars
       ELSE IF ~MayWrite(w)
       THEN Go(w, "idle") /\ UNCHANGED logVars
       ELSE /\ Go(w, "release") /\ UNCHANGED logRows
            /\ IF CloseIsConditional /\ openRows = 0
                 THEN UNCHANGED <<openRows, logCloses>>
                 ELSE /\ openRows' = IF openRows > 0 THEN openRows - 1 ELSE 0
                      /\ logCloses' = Sat2(logCloses + 1)
  /\ UNCHANGED <<leaseVars, seenVars, readVal, readOut, sendOut, memoVars, nodeVars, vendorVars>>

\* The node's output is the value the send carried, as the memo records it.
RecordedBy(w) == IF ReadIsMemoized THEN memoRead ELSE readVal[w]

\* This pass's send failed, and the node has no retries left.
\* The step this pass's failure belongs to, "none" when no step failed.
FailingStep(w) ==
  IF readOut[w] = "threw" THEN "read"
  ELSE IF sendOut[w] \in {"threw", "refused"} THEN "send"
  ELSE "none"

\* The failures counted against a step: its own, or the whole run's when
\* attempts are counted per run.
FailuresOf(st) == IF AttemptsArePerStep THEN failures[st] ELSE attempt

\* This pass's step failed, and that step has no retries left.
RetriesSpent(w) == FailingStep(w) # "none" /\ FailuresOf(FailingStep(w)) + 1 >= MaxAttempts

CountFailure(st) == [failures EXCEPT ![st] = Sat(@ + 1)]

\* The outcome a pass ending here writes for the node, "none" when it writes none.
Outcome(w) ==
  CASE memoSend = "ok" -> "succeeded"
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
  /\ UNCHANGED <<faults, seenVars, readVal, readOut, sendOut, memoVars, logVars, vendorVars>>

-----------------------------------------------------------------------------

\* The step a worker is running, as the lease records it, "none" between steps.
StepOf(w) ==
  IF pc[w] \in {"read", "readMemo"} THEN "read"
  ELSE IF pc[w] \in {"send", "sendMemo"} THEN "send"
  ELSE "none"

\* An expired lease counts against the step its holder was running.
LeaseExpires ==
  /\ sched = "leased" /\ faults < MaxFaults
  /\ sched' = "queued" /\ holder' = 0 /\ attempt' = Sat(attempt + 1)
  /\ faults' = faults + 1
  /\ failures' = IF StepOf(holder) = "none" THEN failures ELSE CountFailure(StepOf(holder))
  /\ UNCHANGED <<workerVars, memoVars, logVars, node, output, refusalRetried,
                 outcomeChanged, vendorVars>>

Crash(w) ==
  /\ pc[w] # "idle" /\ faults < MaxFaults
  /\ Go(w, "idle") /\ faults' = faults + 1
  /\ UNCHANGED <<sched, holder, attempt, seenVars, readVal, readOut, sendOut, memoVars, logVars,
                 nodeVars, vendorVars>>

SweepDeadLease ==
  /\ sched = "leased" /\ holder # 0 /\ pc[holder] = "idle"
  /\ sched' = "queued" /\ holder' = 0 /\ attempt' = Sat(attempt + 1)
  /\ UNCHANGED <<faults, failures, workerVars, memoVars, logVars, node, output, refusalRetried,
                 outcomeChanged, vendorVars>>

Ended == sched = "gone" /\ \A w \in Workers : pc[w] = "idle" /\ UNCHANGED vars

WorkerStep(w) ==
  \/ Claim(w) \/ Open(w) \/ Read(w) \/ ReadMemo(w) \/ Send(w)
  \/ SendMemo(w) \/ Close(w) \/ Release(w)

Next ==
  \/ \E w \in Workers : WorkerStep(w) \/ Crash(w)
  \/ LeaseExpires \/ SweepDeadLease \/ Ended

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

\* The node ends.
NodeEnds == <>(node # "running")

ReachSentTwice      == applies = 1 /\ \E w \in Workers : pc[w] = "send" /\ seenSend[w] = "none" /\ memoSend = "ok"
ReachRefused        == node = "failed" /\ memoSend = "refused"
ReachRetriedThenOk  == node = "succeeded" /\ failures["send"] >= 1
ReachReadRetried    == node = "succeeded" /\ failures["read"] >= 1 /\ memoRead # "none"
ReachStaleRead      == \E w \in Workers : pc[w] = "readMemo" /\ holder # w /\ memoRead # "none"
ReachOpenedTwice    == logRows = 1 /\ \E w \in Workers : pc[w] = "open" /\ LeaseHeldBy(w)
ReachClosedTwice    == logCloses = 1 /\ \E w \in Workers : pc[w] = "close" /\ LeaseHeldBy(w)
ReachStaleRelease   == node # "running" /\ \E w \in Workers : pc[w] = "release" /\ ~LeaseHeldBy(w)
=============================================================================
