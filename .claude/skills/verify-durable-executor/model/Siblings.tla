------------------------------- MODULE Siblings -------------------------------
(***************************************************************************)
(* Two durable steps one pass runs side by side, as the engine runs the    *)
(* branches of a run (executor/pass.ts, executor/runtime.ts).              *)
(*                                                                         *)
(* Step A calls a vendor that applies every call, such as a Slack post     *)
(* with no idempotency key, and step B may throw a retriable error, once.  *)
(* A pass loads the memo when it claims the run and starts each step it    *)
(* has no memo for. A step that throws stops the pass: it starts no other  *)
(* step and the engine abandons the branches still running, while their    *)
(* step bodies run on. The release counts B's failure and re-queues the    *)
(* run.                                                                    *)
(*                                                                         *)
(* A pass can also be interrupted, as a drain or a Worker's budget does.   *)
(* It aborts the signal its step bodies were handed, waits a moment for    *)
(* them, and releases the row. A body that honours the signal stops; one   *)
(* that ignores it, such as a handler's plain Promise, runs on detached    *)
(* and may still call the vendor, but its memo write is refused. A worker  *)
(* may also crash, which ends its bodies with it, and its lease is swept.  *)
(* A live worker whose lease expired mid-step is the Handler and Timing    *)
(* models' case and is left out here.                                      *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Workers, MaxFaults

VARIABLES
  sched,      \* the run's schedule row: "queued" | "leased" | "held" | "gone",
              \*   "held" being queued and due one lease after the release
  holder,     \* owner_token: the worker holding the lease, 0 for none
  faults,     \* interruptions and crashes so far
  pc,         \* each worker: "idle" | "body" | "ending"
  phase,      \* each worker's pass: "running" | "threw"
  aSt,        \* each worker: A's body: "no" | "run" | "done" | "over",
              \*   "done" once the vendor applied the call and the memo write is pending
  bSt,        \* each worker: B's body: "no" | "run" | "threw" | "over"
  seenA,      \* each worker: whether its pass loaded A's memo row
  seenB,      \* each worker: whether its pass loaded B's memo row
  memoA,      \* A's memo row: "none" | "ok"
  memoB,      \* B's memo row: "none" | "ok"
  bThrown,    \* B has thrown its one retriable error
  applies     \* vendor calls A's bodies made, saturating at 3

vars == <<sched, holder, faults, pc, phase, aSt, bSt, seenA, seenB, memoA, memoB,
          bThrown, applies>>

\* The guards the design depends on.
AdmitRunningStepWrites == TRUE  \* after a step threw, a step already running still records its value
ReleaseWaitsForSteps == TRUE    \* the release waits for every step body the pass started to settle
DelayWhileStepsRun == TRUE      \* an interrupted pass whose step still runs re-queues the row one lease out

Sat3(n) == IF n > 3 THEN 3 ELSE n

Init ==
  /\ sched = "queued" /\ holder = 0 /\ faults = 0
  /\ pc = [w \in Workers |-> "idle"] /\ phase = [w \in Workers |-> "running"]
  /\ aSt = [w \in Workers |-> "no"] /\ bSt = [w \in Workers |-> "no"]
  /\ seenA = [w \in Workers |-> FALSE] /\ seenB = [w \in Workers |-> FALSE]
  /\ memoA = "none" /\ memoB = "none" /\ bThrown = FALSE /\ applies = 0

\* Whether the memo write of a step still running commits for worker w: the
\* lease holder's, while its pass runs, or after a sibling threw when the
\* design admits it.
MemoAdmitted(w) ==
  /\ holder = w
  /\ (phase[w] = "running" \/ (phase[w] = "threw" /\ AdmitRunningStepWrites))

\* A body of w's still running or with its memo write pending.
Busy(w) == aSt[w] \in {"run", "done"}

-----------------------------------------------------------------------------

\* A worker's bodies from an earlier pass must have ended before it claims
\* again, since a process runs one pass per row.
Claim(w) ==
  /\ sched = "queued" /\ pc[w] = "idle" /\ ~Busy(w) /\ bSt[w] # "run"
  /\ sched' = "leased" /\ holder' = w
  /\ pc' = [pc EXCEPT ![w] = "body"] /\ phase' = [phase EXCEPT ![w] = "running"]
  /\ aSt' = [aSt EXCEPT ![w] = "no"] /\ bSt' = [bSt EXCEPT ![w] = "no"]
  /\ seenA' = [seenA EXCEPT ![w] = memoA = "ok"]
  /\ seenB' = [seenB EXCEPT ![w] = memoB = "ok"]
  /\ UNCHANGED <<faults, memoA, memoB, bThrown, applies>>

\* A step starts only while its pass runs; a memo hit answers at once.
StartA(w) ==
  /\ pc[w] = "body" /\ aSt[w] = "no" /\ phase[w] = "running"
  /\ aSt' = [aSt EXCEPT ![w] = IF seenA[w] THEN "over" ELSE "run"]
  /\ UNCHANGED <<sched, holder, faults, pc, phase, bSt, seenA, seenB, memoA, memoB, bThrown, applies>>

StartB(w) ==
  /\ pc[w] = "body" /\ bSt[w] = "no" /\ phase[w] = "running"
  /\ bSt' = [bSt EXCEPT ![w] = IF seenB[w] THEN "over" ELSE "run"]
  /\ UNCHANGED <<sched, holder, faults, pc, phase, aSt, seenA, seenB, memoA, memoB, bThrown, applies>>

\* A's body calls the vendor, whether or not its worker still holds the lease.
ApplyA(w) ==
  /\ aSt[w] = "run"
  /\ aSt' = [aSt EXCEPT ![w] = "done"] /\ applies' = Sat3(applies + 1)
  /\ UNCHANGED <<sched, holder, faults, pc, phase, bSt, seenA, seenB, memoA, memoB, bThrown>>

MemoA(w) ==
  /\ aSt[w] = "done"
  /\ aSt' = [aSt EXCEPT ![w] = "over"]
  /\ memoA' = IF MemoAdmitted(w) THEN "ok" ELSE memoA
  /\ UNCHANGED <<sched, holder, faults, pc, phase, bSt, seenA, seenB, memoB, bThrown, applies>>

\* B succeeds and records its value, or throws its one retriable error, which
\* stops the pass.
BOk(w) ==
  /\ bSt[w] = "run"
  /\ bSt' = [bSt EXCEPT ![w] = "over"]
  /\ memoB' = IF MemoAdmitted(w) THEN "ok" ELSE memoB
  /\ UNCHANGED <<sched, holder, faults, pc, phase, aSt, seenA, seenB, memoA, bThrown, applies>>

BThrows(w) ==
  /\ bSt[w] = "run" /\ ~bThrown
  /\ bSt' = [bSt EXCEPT ![w] = "threw"] /\ bThrown' = TRUE
  /\ phase' = [phase EXCEPT ![w] = "threw"]
  /\ UNCHANGED <<sched, holder, faults, pc, aSt, seenA, seenB, memoA, memoB, applies>>

\* The body ends once both branches have, or at once when B threw: the engine
\* abandons a branch still running, while its step body runs on.
BodyEnds(w) ==
  /\ pc[w] = "body"
  /\ \/ bSt[w] = "threw"
     \/ aSt[w] = "over" /\ bSt[w] = "over"
  /\ pc' = [pc EXCEPT ![w] = "ending"]
  /\ UNCHANGED <<sched, holder, faults, phase, aSt, bSt, seenA, seenB, memoA, memoB, bThrown, applies>>

\* The release, written only by the lease holder. It ends the node when both
\* steps are recorded, and otherwise re-queues the run.
Release(w) ==
  /\ pc[w] = "ending"
  /\ ~ReleaseWaitsForSteps \/ ~Busy(w)
  /\ pc' = [pc EXCEPT ![w] = "idle"]
  /\ IF holder = w
       THEN /\ holder' = 0
            /\ sched' = IF memoA = "ok" /\ memoB = "ok" THEN "gone" ELSE "queued"
       ELSE UNCHANGED <<holder, sched>>
  /\ UNCHANGED <<faults, phase, aSt, bSt, seenA, seenB, memoA, memoB, bThrown, applies>>

\* A drain or a budget cut interrupts the pass. B's body stops; A's body stops
\* when it honours the aborted signal and runs on detached when it does not;
\* a memo write already pending commits during the wait. The release re-queues
\* the row, one lease out when A's body may still run.
Interrupt(w) ==
  /\ pc[w] \in {"body", "ending"} /\ holder = w /\ faults < MaxFaults
  /\ \E honours \in BOOLEAN :
       LET aNext == CASE aSt[w] = "run" -> IF honours THEN "over" ELSE "run"
                      [] aSt[w] = "done" -> "over"
                      [] OTHER -> aSt[w]
       IN /\ aSt' = [aSt EXCEPT ![w] = aNext]
          /\ memoA' = IF aSt[w] = "done" /\ MemoAdmitted(w) THEN "ok" ELSE memoA
          /\ sched' = IF aNext = "run" /\ DelayWhileStepsRun THEN "held" ELSE "queued"
  /\ bSt' = [bSt EXCEPT ![w] = IF bSt[w] = "run" THEN "over" ELSE bSt[w]]
  /\ holder' = 0 /\ pc' = [pc EXCEPT ![w] = "idle"] /\ faults' = faults + 1
  /\ UNCHANGED <<phase, seenA, seenB, memoB, bThrown, applies>>

\* A crash ends the worker's bodies with its process.
Crash(w) ==
  /\ pc[w] # "idle" /\ faults < MaxFaults
  /\ pc' = [pc EXCEPT ![w] = "idle"] /\ faults' = faults + 1
  /\ aSt' = [aSt EXCEPT ![w] = "over"] /\ bSt' = [bSt EXCEPT ![w] = "over"]
  /\ UNCHANGED <<sched, holder, phase, seenA, seenB, memoA, memoB, bThrown, applies>>

\* A dead worker's lease is swept.
SweepDeadLease ==
  /\ sched = "leased" /\ holder # 0 /\ pc[holder] = "idle"
  /\ sched' = "queued" /\ holder' = 0
  /\ UNCHANGED <<faults, pc, phase, aSt, bSt, seenA, seenB, memoA, memoB, bThrown, applies>>

\* A row held back one lease falls due. A body that ignored the abort is
\* assumed to end within that lease, which is the bound the design states.
LeaseWindowPasses ==
  /\ sched = "held" /\ \A w \in Workers : aSt[w] # "run"
  /\ sched' = "queued"
  /\ UNCHANGED <<holder, faults, pc, phase, aSt, bSt, seenA, seenB, memoA, memoB, bThrown, applies>>

Ended ==
  /\ sched = "gone" /\ \A w \in Workers : pc[w] = "idle" /\ ~Busy(w)
  /\ UNCHANGED vars

WorkerStep(w) ==
  \/ Claim(w) \/ StartA(w) \/ StartB(w) \/ ApplyA(w) \/ MemoA(w)
  \/ BOk(w) \/ BThrows(w) \/ BodyEnds(w) \/ Release(w)

Next ==
  \/ \E w \in Workers : WorkerStep(w) \/ Interrupt(w) \/ Crash(w)
  \/ SweepDeadLease \/ LeaseWindowPasses \/ Ended

Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ \A w \in Workers : WF_vars(WorkerStep(w))
                 /\ WF_vars(SweepDeadLease) /\ WF_vars(LeaseWindowPasses)

CountersBounded == applies <= 2

-----------------------------------------------------------------------------
(* Rules. *)

\* A's body runs again only after an interruption or a crash: a step that
\* succeeded while its pass held the lease is recorded, so no later pass
\* repeats its vendor call because a sibling step threw.
SucceededStepRunsOnce == applies <= 1 + faults

\* Two bodies of A never run at once, so a worker that picks the run up never
\* calls the vendor beside a step an earlier pass left running.
OneBodyAtATime == Cardinality({w \in Workers : aSt[w] = "run"}) <= 1

\* The node ends.
NodeEnds == <>(sched = "gone")

ReachRecordedAfterThrow == \E w \in Workers : phase[w] = "threw" /\ aSt[w] = "over" /\ memoA = "ok" /\ ~seenA[w]
ReachHeldBack           == sched = "held"
ReachDetachedApply      == applies = 2 /\ faults = 1
ReachEndedAfterThrow    == sched = "gone" /\ bThrown
=============================================================================
