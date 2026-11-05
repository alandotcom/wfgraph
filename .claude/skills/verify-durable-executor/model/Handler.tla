------------------------------- MODULE Handler -------------------------------
(***************************************************************************)
(* The steps inside one node's handler (ADR-0009), under the executor      *)
(* proposed in docs/internal/plans/separate-event-intake-from-durable-    *)
(* execution.md ("The runtime", run(step, fn); "Retries").                 *)
(*                                                                         *)
(* The handler reads a value from vendor A in step "read", then sends it   *)
(* to vendor B in step "send" with an idempotency key built from the       *)
(* execution, node and step ids. Vendor A may answer differently each time *)
(* it is asked. Vendor B applies a key once. The send may succeed, may be  *)
(* refused (a StepFailure, stored as a value so the node fails once), or   *)
(* may throw a retriable error, which ends the pass for a retry.           *)
(*                                                                         *)
(* A pass loads the step memo when it claims the run. run(step, fn) runs   *)
(* fn and then writes the memo row in a transaction that checks the lease *)
(* first, so a crash between the two runs fn again, and a slow worker      *)
(* whose lease expired can still call a vendor before its write is fenced. *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Workers, MaxAttempts, MaxFaults

Values == {"x", "y"}

VARIABLES
  sched,        \* the run's schedule row: "queued" | "leased" | "gone"
  holder,       \* owner_token, 0 for none
  attempt,      \* the attempt counter, saturating past MaxAttempts
  faults,
  pc,           \* each worker: "idle" | "read" | "readMemo" | "send" | "sendMemo" | "release"
  seenRead,     \* each worker: the read memo its pass loaded, "none" if absent
  seenSend,     \* each worker: the send memo its pass loaded: "none" | "ok" | "refused"
  readVal,      \* each worker: the value this pass read
  sendOut,      \* each worker: what this pass's send came back with: "ok" | "refused" | "threw"
  memoRead,     \* the read step's memo row: "none" or the value
  memoSend,     \* the send step's memo row: "none" | "ok" | "refused"
  node,         \* the node's outcome: "running" | "succeeded" | "failed"
  applied,      \* vendor B: the value it applied for the key, "none" if none
  applies,      \* vendor B: how many sends it applied
  output,       \* the node's output, "none" until it succeeds
  refusalRetried, \* a refused send was retried as if it were a transient error
  sentAfterRefusal, \* the lease holder sent again after a refusal was recorded
  failures      \* retriable failures and expired leases

vars == <<sched, holder, attempt, faults, pc, seenRead, seenSend, readVal, sendOut,
          memoRead, memoSend, node, applied, applies, output, refusalRetried,
          sentAfterRefusal, failures>>

Sat(n) == IF n > MaxAttempts + 1 THEN MaxAttempts + 1 ELSE n

\* The guards the design depends on.
LeaseHeldBy(w) == holder = w                 \* the memo write checks owner_token
SendCarriesAKey == TRUE                      \* callExternal passes an idempotency key
ReadIsMemoized == TRUE                       \* the handler wraps the read in step.run
RefusalIsAValue == TRUE                      \* a StepFailure is stored, not thrown

Init ==
  /\ sched = "queued" /\ holder = 0 /\ attempt = 0 /\ faults = 0
  /\ pc = [w \in Workers |-> "idle"]
  /\ seenRead = [w \in Workers |-> "none"] /\ seenSend = [w \in Workers |-> "none"]
  /\ readVal = [w \in Workers |-> "x"] /\ sendOut = [w \in Workers |-> "ok"]
  /\ memoRead = "none" /\ memoSend = "none" /\ node = "running"
  /\ applied = "none" /\ applies = 0 /\ output = "none" /\ refusalRetried = FALSE
  /\ sentAfterRefusal = FALSE /\ failures = 0

workerVars == <<pc, seenRead, seenSend, readVal, sendOut>>
others == <<memoRead, memoSend, node, applied, applies, output, refusalRetried,
            sentAfterRefusal, failures>>

Go(w, s) == pc' = [pc EXCEPT ![w] = s]

-----------------------------------------------------------------------------

Claim(w) ==
  /\ sched = "queued" /\ pc[w] = "idle"
  /\ sched' = "leased" /\ holder' = w
  /\ seenRead' = [seenRead EXCEPT ![w] = IF ReadIsMemoized THEN memoRead ELSE "none"]
  /\ seenSend' = [seenSend EXCEPT ![w] = memoSend]
  /\ Go(w, "read")
  /\ UNCHANGED <<attempt, faults, readVal, sendOut, others>>

\* The read step: a memo hit returns the recorded value; otherwise ask vendor A.
Read(w) ==
  /\ pc[w] = "read"
  /\ IF seenRead[w] # "none"
       THEN /\ readVal' = [readVal EXCEPT ![w] = seenRead[w]] /\ Go(w, "send")
       ELSE \E v \in Values : readVal' = [readVal EXCEPT ![w] = v] /\ Go(w, "readMemo")
  /\ UNCHANGED <<sched, holder, attempt, faults, seenRead, seenSend, sendOut, others>>

WriteMemo(old, new) == IF old = "none" THEN new ELSE old

ReadMemo(w) ==
  /\ pc[w] = "readMemo"
  /\ IF LeaseHeldBy(w) /\ ReadIsMemoized
       THEN /\ memoRead' = WriteMemo(memoRead, readVal[w]) /\ Go(w, "send")
       ELSE IF ~ReadIsMemoized /\ LeaseHeldBy(w)
       THEN /\ Go(w, "send") /\ UNCHANGED memoRead
       ELSE /\ Go(w, "idle") /\ UNCHANGED memoRead
  /\ UNCHANGED <<sched, holder, attempt, faults, seenRead, seenSend, readVal, sendOut,
                 memoSend, node, applied, applies, output, refusalRetried,
                 sentAfterRefusal, failures>>

\* The send step: a memo hit returns the recorded outcome; otherwise call vendor B.
Send(w) ==
  /\ pc[w] = "send"
  /\ IF seenSend[w] # "none"
       THEN /\ sendOut' = [sendOut EXCEPT ![w] = seenSend[w]] /\ Go(w, "release")
            /\ UNCHANGED <<applied, applies, sentAfterRefusal>>
       ELSE \E out \in {"ok", "refused", "threw"} :
              /\ sendOut' = [sendOut EXCEPT ![w] = out]
              /\ sentAfterRefusal' = (sentAfterRefusal \/ (memoSend = "refused" /\ LeaseHeldBy(w)))
              /\ IF out = "ok"
                   THEN /\ applied' = IF applied = "none" \/ ~SendCarriesAKey THEN readVal[w] ELSE applied
                        /\ applies' = IF applied = "none" \/ ~SendCarriesAKey THEN applies + 1 ELSE applies
                   ELSE UNCHANGED <<applied, applies>>
              /\ Go(w, IF out = "threw" \/ (out = "refused" /\ ~RefusalIsAValue) THEN "release" ELSE "sendMemo")
  /\ UNCHANGED <<sched, holder, attempt, faults, seenRead, seenSend, readVal, memoRead,
                 memoSend, node, output, refusalRetried, failures>>

SendMemo(w) ==
  /\ pc[w] = "sendMemo"
  /\ IF LeaseHeldBy(w)
       THEN /\ memoSend' = WriteMemo(memoSend, sendOut[w]) /\ Go(w, "release")
       ELSE /\ Go(w, "idle") /\ UNCHANGED memoSend
  /\ UNCHANGED <<sched, holder, attempt, faults, seenRead, seenSend, readVal, sendOut,
                 memoRead, node, applied, applies, output, refusalRetried,
                 sentAfterRefusal, failures>>

\* The node's output is the value the send carried, as the memo records it.
Recorded == IF ReadIsMemoized THEN memoRead ELSE readVal[holder]

Release(w) ==
  /\ pc[w] = "release"
  /\ IF ~LeaseHeldBy(w)
       THEN /\ Go(w, "idle")
            /\ UNCHANGED <<sched, holder, attempt, node, output, refusalRetried, failures>>
       ELSE /\ holder' = 0 /\ Go(w, "idle")
            /\ CASE memoSend = "ok" ->
                      /\ node' = "succeeded" /\ sched' = "gone" /\ output' = Recorded
                      /\ UNCHANGED <<attempt, failures, refusalRetried>>
                 [] memoSend = "refused" ->
                      /\ node' = "failed" /\ sched' = "gone"
                      /\ UNCHANGED <<attempt, output, failures, refusalRetried>>
                 [] sendOut[w] \in {"threw", "refused"} /\ attempt + 1 >= MaxAttempts ->
                      /\ node' = "failed" /\ sched' = "gone" /\ failures' = Sat(failures + 1)
                      /\ refusalRetried' = (refusalRetried \/ sendOut[w] = "refused")
                      /\ UNCHANGED <<attempt, output>>
                 [] sendOut[w] \in {"threw", "refused"} ->
                      /\ sched' = "queued" /\ attempt' = Sat(attempt + 1)
                      /\ failures' = Sat(failures + 1)
                      /\ refusalRetried' = (refusalRetried \/ sendOut[w] = "refused")
                      /\ UNCHANGED <<node, output>>
                 [] OTHER ->
                      /\ sched' = "queued" /\ UNCHANGED <<attempt, node, output, failures, refusalRetried>>
  /\ UNCHANGED <<faults, seenRead, seenSend, readVal, sendOut, memoRead, memoSend, applied,
                 applies, sentAfterRefusal>>

-----------------------------------------------------------------------------

LeaseExpires ==
  /\ sched = "leased" /\ faults < MaxFaults
  /\ sched' = "queued" /\ holder' = 0 /\ attempt' = Sat(attempt + 1)
  /\ faults' = faults + 1 /\ failures' = Sat(failures + 1)
  /\ UNCHANGED <<workerVars, memoRead, memoSend, node, applied, applies, output,
                 refusalRetried, sentAfterRefusal>>

Crash(w) ==
  /\ pc[w] # "idle" /\ faults < MaxFaults
  /\ Go(w, "idle") /\ faults' = faults + 1
  /\ UNCHANGED <<sched, holder, attempt, seenRead, seenSend, readVal, sendOut, others>>

SweepDeadLease ==
  /\ sched = "leased" /\ holder # 0 /\ pc[holder] = "idle"
  /\ sched' = "queued" /\ holder' = 0 /\ attempt' = Sat(attempt + 1)
  /\ failures' = Sat(failures + 1)
  /\ UNCHANGED <<faults, workerVars, memoRead, memoSend, node, applied, applies, output,
                 refusalRetried, sentAfterRefusal>>

Ended == sched = "gone" /\ \A w \in Workers : pc[w] = "idle" /\ UNCHANGED vars

WorkerStep(w) == Claim(w) \/ Read(w) \/ ReadMemo(w) \/ Send(w) \/ SendMemo(w) \/ Release(w)

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

\* The node fails only on a refusal or after its retries were spent on failures.
FailedOnlyOnRefusalOrSpentRetries == node = "failed" => (memoSend = "refused" \/ failures >= MaxAttempts)

\* The node ends.
NodeEnds == <>(node # "running")

ReachSentTwice      == applies = 1 /\ \E w \in Workers : pc[w] = "send" /\ seenSend[w] = "none" /\ memoSend = "ok"
ReachRefused        == node = "failed" /\ memoSend = "refused"
ReachRetriedThenOk  == node = "succeeded" /\ failures >= 1
ReachStaleRead      == \E w \in Workers : pc[w] = "readMemo" /\ holder # w /\ memoRead # "none"
=============================================================================
