------------------------------ MODULE Delivery ------------------------------
(***************************************************************************)
(* One arrival delivered to several workflows, under the executor proposed *)
(* in docs/internal/plans/separate-event-intake-from-durable-execution.md. *)
(* Section 7.2 runs the delivery fan-out as a durable delivery body:       *)
(* per subscribing workflow, a lifecycle step, then every page of Wait     *)
(* candidates saved, then each saved page offered the arrival.             *)
(*                                                                         *)
(* The arrival is Event X. Two workflows subscribe to it:                  *)
(*                                                                         *)
(*   W1 starts on X with newest-wins Concurrency, and its runs have a Wait *)
(*      on X. Run R1old is parked on that Wait when X arrives (row r1old). *)
(*      The run X starts, R1new, parks on the same Wait later (row r1new). *)
(*   W2 cancels on X, behind a Cancel Filter that may decline it, and has  *)
(*      two runs parked on Waits on X. R2 is for the Entity X names: it    *)
(*      waits at row w2a, then at a second Wait on X (row w2b), and if the *)
(*      Cancel claims it, its Canceled outlet parks a Wait on X (row rc).  *)
(*      R3 is for another Entity and waits at row r3.                      *)
(*                                                                         *)
(* Pages hold one row each, in id order: r1old, r1new, w2a, r3, w2b, rc.   *)
(* Rows r1new, w2b and rc are created only after X arrives. Workers claim  *)
(* the delivery under a lease; each step's write and its memo row commit   *)
(* together, so a crash re-runs a step whose memo is missing.              *)
(*                                                                         *)
(* A third workflow, not modelled, may fail on every retry, so the         *)
(* delivery settles failed after delivering W1 and W2. Its schedule row is *)
(* then kept `settled` with its memo, and one resend of the arrival's key  *)
(* reopens it, which re-runs the body against that memo.                   *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS Workers, MaxFaults

Rows == <<"r1old", "r1new", "w2a", "r3", "w2b", "rc">>   \* in id order
RowSet == {Rows[i] : i \in 1..Len(Rows)}
RunOf == [r \in RowSet |-> CASE r \in {"r1old"} -> "R1old" [] r = "r1new" -> "R1new"
                                 [] r \in {"w2a", "w2b", "rc"} -> "R2" [] r = "r3" -> "R3"]
WorkflowOf == [r \in RowSet |-> IF RunOf[r] \in {"R1old", "R1new"} THEN "W1" ELSE "W2"]
Workflows == <<"W1", "W2">>

VARIABLES
  dsched,      \* the delivery's schedule row: "queued" | "leased" | "gone" | "settled"
  holder,      \* the delivery's lease holder, 0 for none
  faults,
  pc,          \* each worker: <<stage, workflow index>>, with stage "idle" when it has no pass
  lifeDone,    \* each workflow: its lifecycle step's memo row exists
  memoLife,    \* each workflow: the runs its lifecycle step settled
  pagesDone,   \* each workflow: its candidate pages are saved
  memoPages,   \* each workflow: the candidate rows its pages saved, in order
  scanned,     \* each workflow: the rows scanned so far, for a scan made page by page
  memoWoken,   \* each workflow: how many saved pages have been offered the arrival
  row,         \* each wait row: "none" | "waiting" | "woken" | "cancelled"
  run,         \* each run: "running" | "superseded" | "claimed" | "none"
  declined,    \* whether W2's Cancel Filter declined X (chosen at the start)
  wokenByX,    \* each wait row: how many times X woke it
  reopened     \* whether a resend has reopened the failed delivery

vars == <<dsched, holder, faults, pc, lifeDone, memoLife, pagesDone, memoPages, scanned, memoWoken, row,
          run, declined, wokenByX, reopened>>
memoVars == <<lifeDone, memoLife, pagesDone, memoPages, memoWoken>>

\* The guards the design depends on.
ExcludeSettledRuns == TRUE        \* candidates leave out the runs this arrival settled
SavePagesBeforeWaking == TRUE     \* every page is saved before any page is offered
KeepMemoOnReopen == TRUE          \* failDelivery keeps the schedule row `settled`, and a resend requeues it
WakeIsUnclaimed(r) == row[r] = "waiting"   \* claimWaitState: `status = 'waiting'`
LeaseHeldBy(w) == holder = w

Init ==
  /\ dsched = "queued" /\ holder = 0 /\ faults = 0
  /\ pc = [w \in Workers |-> <<"idle", 0>>]
  /\ lifeDone = [i \in 1..2 |-> FALSE] /\ memoLife = [i \in 1..2 |-> {}]
  /\ pagesDone = [i \in 1..2 |-> FALSE] /\ memoPages = [i \in 1..2 |-> <<>>]
  /\ scanned = [i \in 1..2 |-> <<>>] /\ memoWoken = [i \in 1..2 |-> 0]
  /\ row = [r \in RowSet |-> IF r \in {"r1old", "w2a", "r3"} THEN "waiting" ELSE "none"]
  /\ run = [x \in {"R1old", "R1new", "R2", "R3"} |-> IF x = "R1new" THEN "none" ELSE "running"]
  /\ declined \in BOOLEAN
  /\ wokenByX = [r \in RowSet |-> 0]
  /\ reopened = FALSE

-----------------------------------------------------------------------------
(* The delivery body. *)

Claim(w) ==
  /\ dsched = "queued" /\ pc[w][1] = "idle"
  /\ dsched' = "leased" /\ holder' = w /\ pc' = [pc EXCEPT ![w] = <<"life", 1>>]
  /\ UNCHANGED <<faults, lifeDone, memoLife, pagesDone, memoPages, scanned, memoWoken, row, run, declined, wokenByX, reopened>>

Fenced(w) ==
  /\ pc[w][1] # "idle" /\ ~LeaseHeldBy(w)
  /\ pc' = [pc EXCEPT ![w] = <<"idle", 0>>]
  /\ UNCHANGED <<dsched, holder, faults, lifeDone, memoLife, pagesDone, memoPages, scanned, memoWoken, row, run,
                 declined, wokenByX, reopened>>

Stage(w) == pc[w][1]
Wf(w) == pc[w][2]
Go(w, stage, i) == pc' = [pc EXCEPT ![w] = <<stage, i>>]

\* W1: start a run on X, superseding R1old. A supersede is a policy cancel, so
\* its parked Wait is cancelled.
Life1 ==
  /\ run' = [run EXCEPT !["R1old"] = "superseded", !["R1new"] = "running"]
  /\ row' = [row EXCEPT !["r1old"] = IF @ = "waiting" THEN "cancelled" ELSE @]
  /\ UNCHANGED declined

\* W2: cancel on X. A Cancel Filter that accepts claims R2 and resolves its open
\* Started-side parks; one that declines leaves every run alone.
Life2 ==
  /\ IF declined
       THEN UNCHANGED <<run, row>>
       ELSE /\ run' = [run EXCEPT !["R2"] = "claimed"]
            /\ row' = [r \in RowSet |-> IF r \in {"w2a", "w2b"} /\ row[r] = "waiting" THEN "cancelled" ELSE row[r]]
  /\ UNCHANGED declined

Settled(i) ==
  IF i = 1 THEN {"R1old", "R1new"}
  ELSE IF declined THEN {} ELSE {"R2"}

Lifecycle(w) ==
  /\ Stage(w) = "life" /\ LeaseHeldBy(w)
  /\ IF lifeDone[Wf(w)]
       THEN UNCHANGED <<lifeDone, memoLife, row, run, declined>>
       ELSE /\ (IF Wf(w) = 1 THEN Life1 ELSE Life2)
            /\ lifeDone' = [lifeDone EXCEPT ![Wf(w)] = TRUE]
            /\ memoLife' = [memoLife EXCEPT ![Wf(w)] = Settled(Wf(w))]
  /\ Go(w, "scan", Wf(w))
  /\ UNCHANGED <<dsched, holder, faults, pagesDone, memoPages, scanned, memoWoken, wokenByX, reopened>>

\* listWaitsForEvent: rows still waiting, of this workflow, of a run in flight,
\* past the cursor, leaving out the runs this arrival settled.
Candidate(i, r, after) ==
  /\ WorkflowOf[r] = Workflows[i] /\ row[r] = "waiting"
  /\ run[RunOf[r]] \in {"running", "claimed"}
  /\ ~(ExcludeSettledRuns /\ RunOf[r] \in memoLife[i])
  /\ \E k \in 1..Len(Rows) : Rows[k] = r /\ k > after

IndexOf(r) == CHOOSE k \in 1..Len(Rows) : Rows[k] = r
Cursor(seq) == IF seq = <<>> THEN 0 ELSE IndexOf(seq[Len(seq)])
NextCandidate(i, after) ==
  LET found == {k \in 1..Len(Rows) : Candidate(i, Rows[k], after)}
  IN IF found = {} THEN "none" ELSE Rows[CHOOSE k \in found : \A j \in found : k <= j]

\* Scan every page of candidates and save them before any page is offered.
ScanAllPages(w) ==
  /\ Stage(w) = "scan" /\ LeaseHeldBy(w) /\ SavePagesBeforeWaking
  /\ IF pagesDone[Wf(w)]
       THEN UNCHANGED <<pagesDone, memoPages>>
       ELSE /\ pagesDone' = [pagesDone EXCEPT ![Wf(w)] = TRUE]
            /\ memoPages' = [memoPages EXCEPT ![Wf(w)] =
                                SelectSeq(Rows, LAMBDA r : Candidate(Wf(w), r, 0))]
  /\ Go(w, "wake", Wf(w))
  /\ UNCHANGED <<dsched, holder, faults, lifeDone, memoLife, scanned, memoWoken, row, run, declined, wokenByX, reopened>>

\* Offer the next saved page the arrival: the claim wakes a row still waiting.
Offer(r) ==
  /\ row' = [row EXCEPT ![r] = IF WakeIsUnclaimed(r) THEN "woken" ELSE @]
  /\ wokenByX' = [wokenByX EXCEPT ![r] = IF WakeIsUnclaimed(r) THEN @ + 1 ELSE @]

\* run(step, fn) runs the step's work and then writes its memo row in a
\* transaction of its own, so a crash between the two offers the page again.
WakeSavedPage(w) ==
  /\ Stage(w) = "wake" /\ LeaseHeldBy(w) /\ SavePagesBeforeWaking
  /\ LET i == Wf(w) IN
     IF memoWoken[i] < Len(memoPages[i])
       THEN /\ Offer(memoPages[i][memoWoken[i] + 1])
            /\ Go(w, "woken", i)
       ELSE /\ (IF i = 1 THEN Go(w, "life", 2) ELSE Go(w, "finish", 2))
            /\ UNCHANGED <<row, wokenByX>>
  /\ UNCHANGED <<dsched, holder, faults, lifeDone, memoLife, pagesDone, memoPages, scanned,
                 memoWoken, run, declined, reopened>>

RecordWokenPage(w) ==
  /\ Stage(w) = "woken" /\ LeaseHeldBy(w)
  /\ memoWoken' = [memoWoken EXCEPT ![Wf(w)] = @ + 1]
  /\ Go(w, "wake", Wf(w))
  /\ UNCHANGED <<dsched, holder, faults, lifeDone, memoLife, pagesDone, memoPages, scanned,
                 row, run, declined, wokenByX, reopened>>

\* The alternative the design rules out: scan one page, offer it, scan the next.
ScanAndWakeByPage(w) ==
  /\ Stage(w) \in {"scan", "wake"} /\ LeaseHeldBy(w) /\ ~SavePagesBeforeWaking
  /\ LET i == Wf(w)
         next == NextCandidate(i, Cursor(scanned[i]))
     IN IF next = "none"
          THEN /\ (IF i = 1 THEN Go(w, "life", 2) ELSE Go(w, "finish", 2))
               /\ UNCHANGED <<scanned, row, wokenByX>>
          ELSE /\ scanned' = [scanned EXCEPT ![i] = Append(@, next)]
               /\ Offer(next)
               /\ UNCHANGED pc
  /\ UNCHANGED <<dsched, holder, faults, lifeDone, memoLife, pagesDone, memoPages, memoWoken, run, declined,
                 reopened>>

Finish(w) ==
  /\ Stage(w) = "finish" /\ LeaseHeldBy(w)
  /\ dsched' = "gone" /\ holder' = 0 /\ pc' = [pc EXCEPT ![w] = <<"idle", 0>>]
  /\ UNCHANGED <<faults, lifeDone, memoLife, pagesDone, memoPages, scanned, memoWoken, row, run, declined, wokenByX, reopened>>

\* failDelivery, once the unmodelled workflow's step is past its retries: the
\* inbox row is marked failed, and the schedule row is kept `settled` with its
\* memo. Without KeepMemoOnReopen the row and its memo are deleted.
FinishFailed(w) ==
  /\ Stage(w) = "finish" /\ LeaseHeldBy(w) /\ ~reopened
  /\ dsched' = "settled" /\ holder' = 0 /\ pc' = [pc EXCEPT ![w] = <<"idle", 0>>]
  /\ UNCHANGED <<faults, lifeDone, memoLife, pagesDone, memoPages, scanned, memoWoken, row, run, declined, wokenByX, reopened>>

\* A resend of the failed row's key reopens it: writeArrival queues the
\* settled schedule row again, and the next claim replays the body against
\* the memo it kept. Without KeepMemoOnReopen the resend writes a new
\* schedule row with an empty memo.
Reopen ==
  /\ dsched = "settled" /\ ~reopened
  /\ dsched' = "queued" /\ reopened' = TRUE
  /\ IF KeepMemoOnReopen
       THEN UNCHANGED memoVars
       ELSE /\ lifeDone' = [i \in 1..2 |-> FALSE] /\ memoLife' = [i \in 1..2 |-> {}]
            /\ pagesDone' = [i \in 1..2 |-> FALSE] /\ memoPages' = [i \in 1..2 |-> <<>>]
            /\ memoWoken' = [i \in 1..2 |-> 0]
  /\ UNCHANGED <<holder, faults, pc, scanned, row, run, declined, wokenByX>>

-----------------------------------------------------------------------------
(* Faults, and the runs the executor drives beside the delivery. *)

Crash(w) ==
  /\ pc[w][1] # "idle" /\ faults < MaxFaults
  /\ pc' = [pc EXCEPT ![w] = <<"idle", 0>>] /\ faults' = faults + 1
  /\ UNCHANGED <<dsched, holder, lifeDone, memoLife, pagesDone, memoPages, scanned, memoWoken, row, run, declined, wokenByX, reopened>>

SweepLease ==
  /\ dsched = "leased" /\ (pc[holder][1] = "idle" \/ faults < MaxFaults)
  /\ faults' = IF pc[holder][1] = "idle" THEN faults ELSE faults + 1
  /\ dsched' = "queued" /\ holder' = 0
  /\ UNCHANGED <<pc, lifeDone, memoLife, pagesDone, memoPages, scanned, memoWoken, row, run, declined, wokenByX, reopened>>

\* The run X started reaches its Wait on X.
R1NewParks ==
  /\ run["R1new"] = "running" /\ row["r1new"] = "none"
  /\ row' = [row EXCEPT !["r1new"] = "waiting"]
  /\ UNCHANGED <<dsched, holder, faults, pc, lifeDone, memoLife, pagesDone, memoPages, scanned, memoWoken, run, declined, wokenByX, reopened>>

\* R2 resumes from its first Wait and parks on the second, also on X.
R2ParksAgain ==
  /\ run["R2"] = "running" /\ row["w2a"] = "woken" /\ row["w2b"] = "none"
  /\ row' = [row EXCEPT !["w2b"] = "waiting"]
  /\ UNCHANGED <<dsched, holder, faults, pc, lifeDone, memoLife, pagesDone, memoPages, scanned, memoWoken, run, declined, wokenByX, reopened>>

\* A claimed R2 enters its Canceled outlet and parks there on a Wait on X.
R2ParksCanceledWait ==
  /\ run["R2"] = "claimed" /\ row["rc"] = "none"
  /\ row' = [row EXCEPT !["rc"] = "waiting"]
  /\ UNCHANGED <<dsched, holder, faults, pc, lifeDone, memoLife, pagesDone, memoPages, scanned, memoWoken, run, declined, wokenByX, reopened>>

Ended == dsched \in {"gone", "settled"} /\ \A w \in Workers : pc[w][1] = "idle" /\ UNCHANGED vars

WorkerStep(w) ==
  \/ Claim(w) \/ Fenced(w) \/ Lifecycle(w) \/ ScanAllPages(w) \/ WakeSavedPage(w) \/ RecordWokenPage(w)
  \/ ScanAndWakeByPage(w) \/ Finish(w) \/ FinishFailed(w)

Next ==
  \/ \E w \in Workers : WorkerStep(w) \/ Crash(w)
  \/ SweepLease \/ R1NewParks \/ R2ParksAgain \/ R2ParksCanceledWait \/ Reopen \/ Ended

Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ \A w \in Workers : WF_vars(WorkerStep(w)) /\ WF_vars(SweepLease /\ pc[holder][1] = "idle")

CountersBounded == \A r \in RowSet : wokenByX[r] <= 2

-----------------------------------------------------------------------------
(* Rules. *)

\* An arrival never wakes a Wait in a run it started.
NoWakeInTheRunItStarted == wokenByX["r1new"] = 0

\* An arrival never wakes a Wait in a run it superseded or claimed.
NoWakeInARunItSettled ==
  /\ wokenByX["r1old"] = 0
  /\ ~declined => wokenByX["w2a"] = 0 /\ wokenByX["rc"] = 0

\* One arrival never resumes two Waits of the same run one after the other,
\* including across a resend that reopens its failed delivery.
NoSecondWaitFromOneArrival == wokenByX["w2b"] = 0

\* An arrival wakes each Wait at most once, however often its delivery runs.
EachWaitWokenOnce == \A r \in RowSet : wokenByX[r] <= 1

\* Every Wait of a surviving run that was parked on X when it arrived is woken by it.
SurvivingWaitsAreWoken ==
  <>(dsched \in {"gone", "settled"} /\ wokenByX["r3"] = 1 /\ (declined => wokenByX["w2a"] = 1))

ReachR2WokenThenParkedAgain == wokenByX["w2a"] = 1 /\ row["w2b"] = "waiting"
ReachNewRunParksBeforeScan  == row["r1new"] = "waiting" /\ ~pagesDone[1]
ReachCanceledWaitParked     == row["rc"] = "waiting"
ReachRedeliveredAfterCrash  == faults = 1 /\ dsched = "gone"
ReachReopenedAfterR2ParkedAgain == reopened /\ dsched = "gone" /\ row["w2b"] = "waiting" /\ wokenByX["w2a"] = 1
ReachPageOfferedTwice       == \E w \in Workers : Stage(w) = "wake" /\ memoWoken[Wf(w)] < Len(memoPages[Wf(w)])
                                 /\ row[memoPages[Wf(w)][memoWoken[Wf(w)] + 1]] = "woken"
=============================================================================
