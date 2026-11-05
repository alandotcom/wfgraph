------------------------------- MODULE Intake -------------------------------
(***************************************************************************)
(* The event inbox and delivery proposed in section 7 of                   *)
(* docs/internal/plans/separate-event-intake-from-durable-execution.md,    *)
(* together with the Concurrency rules delivery applies when it opens an   *)
(* Execution (ADR-0007, CONTEXT.md "Concurrency").                         *)
(*                                                                         *)
(* One workflow with one Entity. The host raises three arrivals: two Start *)
(* Events, "s1" and "s2", and one Cancel Event, "c". The host sends "s1"   *)
(* twice with the same idempotency key. An arrival enters the              *)
(* inbox either through app.events.send, which inserts the inbox row and   *)
(* its delivery's schedule row together, or inside the host's own          *)
(* transaction, which inserts the inbox row alone and leaves the poll to   *)
(* schedule its delivery.                                                  *)
(*                                                                         *)
(* A delivery is a durable body on the executor: workers claim its         *)
(* schedule row under a lease, run its lifecycle step, record that step in *)
(* the memo, and finish. The lifecycle step for a Start Event is           *)
(* startForEntity: under the Entity's lock it applies Concurrency and      *)
(* inserts the Execution and the Execution's schedule row in one           *)
(* transaction. The step's own write and its memo row are two              *)
(* transactions, so a crash between them runs the step again, and the      *)
(* unique (workflow_id, delivery_id) index answers the second run with the *)
(* Execution the first one opened.                                         *)
(*                                                                         *)
(* Concurrency is chosen per behaviour: "newest" (newest wins) or "first"  *)
(* (first wins). An Execution's own run is abstracted to one step that     *)
(* finishes it; the run model checks what happens inside one.              *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Workers, MaxFaults

Starts   == {"s1", "s2"}
Arrivals == Starts \cup {"c"}
Copies   == {1, 2}                    \* an inbox row for a key, and a duplicate row

\* How many times the host sends each arrival: "s1" twice, to exercise the
\* inbox key, and the others once.
SendCap(k) == IF k = "s1" THEN 2 ELSE 1
Rows     == Arrivals \X Copies         \* inbox row ids
Execs    == Starts \X Copies \X Copies \* Execution ids: the inbox row, and a second insert

VARIABLES
  mode,         \* Concurrency of this workflow: "newest" | "first"
  sends,        \* host sends per arrival
  inbox,        \* each inbox row: "none" | "present"
  dsched,       \* each delivery's schedule row: "none" | "queued" | "leased" | "gone"
  dholder,      \* each delivery's lease holder, 0 for none
  written,      \* each delivery: its lifecycle step's write has committed
  memo,         \* each delivery: its lifecycle step's memo row exists
  pc,           \* each worker: "idle" | "write" | "memo" | "finish"
  cur,          \* each worker: the delivery its pass is on
  exec,         \* each Execution: "none" | "running" | "claimed" | "completed"
                \*   | "canceled" | "superseded"
  esched,       \* each Execution's schedule row: "none" | "present" | "gone"
  refused,      \* each inbox row of a Start arrival: recorded as a Refused Start
  eligRefused,  \* each inbox row: refused by admission Entity Eligibility
  refusedChanged, \* an arrival Eligibility refused changed a run anyway
  faults,
  opened        \* Executions opened per Start arrival

vars == <<mode, sends, inbox, dsched, dholder, written, memo, pc, cur, exec, esched,
          refused, eligRefused, refusedChanged, faults, opened>>

\* The guards the design depends on.
InboxKeyIsUnique == TRUE                 \* unique (name, idempotency_key) on the inbox
DeliveryIdIsUnique == TRUE               \* unique (workflow_id, delivery_id) on executions
RefusalIsConsulted == TRUE               \* answerFromCommittedDecision reads a prior refusal first
EligibilityBeforeConcurrency == TRUE     \* Precedence: admission Eligibility, then Concurrency
ExecutionAndScheduleTogether == TRUE     \* one transaction inserts both rows
SupersedeDropsSchedule == TRUE           \* a supersede deletes the run's schedule row
LeaseHeldBy(w) == dholder[cur[w]] = w

Live == {x \in Execs : exec[x] = "running"}

Init ==
  /\ mode \in {"newest", "first"}
  /\ sends = [k \in Arrivals |-> 0]
  /\ inbox = [r \in Rows |-> "none"] /\ dsched = [r \in Rows |-> "none"]
  /\ dholder = [r \in Rows |-> 0]
  /\ written = [r \in Rows |-> FALSE] /\ memo = [r \in Rows |-> FALSE]
  /\ pc = [w \in Workers |-> "idle"] /\ cur = [w \in Workers |-> <<"c", 1>>]
  /\ exec = [x \in Execs |-> "none"] /\ esched = [x \in Execs |-> "none"]
  /\ refused = [r \in Rows |-> FALSE] /\ faults = 0
  /\ eligRefused = [r \in Rows |-> FALSE] /\ refusedChanged = FALSE
  /\ opened = [k \in Starts |-> 0]

execVars == <<exec, esched, refused, eligRefused, refusedChanged, opened>>

-----------------------------------------------------------------------------
(* Sources, section 7.3. *)

\* The inbox row a send writes: the key's existing row when the key is unique.
NewRow(k) ==
  IF inbox[<<k, 1>>] = "none" THEN <<k, 1>>
  ELSE IF InboxKeyIsUnique THEN <<k, 1>> ELSE <<k, 2>>

\* app.events.send: the inbox row and its delivery's schedule row in one transaction.
SendViaApp(k) ==
  /\ sends[k] < SendCap(k)
  /\ LET r == NewRow(k) IN
       /\ sends' = [sends EXCEPT ![k] = @ + 1]
       /\ IF inbox[r] = "none"
            THEN /\ inbox' = [inbox EXCEPT ![r] = "present"]
                 /\ dsched' = [dsched EXCEPT ![r] = "queued"]
            ELSE UNCHANGED <<inbox, dsched>>
  /\ UNCHANGED <<mode, dholder, written, memo, pc, cur, execVars, faults>>

\* The host's own transaction inserts the inbox row; its delivery waits for the poll.
SendInHostTransaction(k) ==
  /\ sends[k] < SendCap(k)
  /\ LET r == NewRow(k) IN
       /\ sends' = [sends EXCEPT ![k] = @ + 1]
       /\ inbox' = [inbox EXCEPT ![r] = "present"]
  /\ UNCHANGED <<mode, dsched, dholder, written, memo, pc, cur, execVars, faults>>

\* The poll schedules the delivery of an inbox row that has none.
PollInbox(r) ==
  /\ inbox[r] = "present" /\ dsched[r] = "none"
  /\ dsched' = [dsched EXCEPT ![r] = "queued"]
  /\ UNCHANGED <<mode, sends, inbox, dholder, written, memo, pc, cur, execVars, faults>>

-----------------------------------------------------------------------------
(* Delivery, section 7.2. *)

ClaimDelivery(w, r) ==
  /\ pc[w] = "idle" /\ dsched[r] = "queued"
  /\ dsched' = [dsched EXCEPT ![r] = "leased"] /\ dholder' = [dholder EXCEPT ![r] = w]
  /\ cur' = [cur EXCEPT ![w] = r]
  /\ pc' = [pc EXCEPT ![w] = IF memo[r] THEN "finish" ELSE "write"]
  /\ UNCHANGED <<mode, sends, inbox, written, memo, execVars, faults>>

DeliveryFenced(w) ==
  /\ pc[w] # "idle" /\ ~LeaseHeldBy(w)
  /\ pc' = [pc EXCEPT ![w] = "idle"]
  /\ UNCHANGED <<mode, sends, inbox, dsched, dholder, written, memo, cur, execVars, faults>>

\* The Execution a second run of the same delivery would insert.
SecondCopy(x) == <<x[1], x[2], 2>>

\* Newest-wins supersedes every live run: its status, and its schedule row.
Supersede(exclude) ==
  /\ exec' = [y \in Execs |-> IF y \in Live /\ y # exclude THEN "superseded" ELSE exec[y]]
  /\ esched' = [y \in Execs |-> IF y \in Live /\ y # exclude /\ SupersedeDropsSchedule THEN "gone" ELSE esched[y]]

\* startForEntity for a Start arrival. A retried delivery is answered from what
\* its first attempt committed (answerFromCommittedDecision). Otherwise the
\* host's Entity resolver is read again, which can answer differently on each
\* attempt, and admission Eligibility decides before Concurrency does
\* (CONTEXT.md "Precedence").
StartWrite(r) ==
  LET k == r[1]
      first == <<k, r[2], 1>>
      x == IF exec[first] = "none" THEN first ELSE SecondCopy(first)
  IN
  IF exec[first] # "none" /\ DeliveryIdIsUnique
    THEN UNCHANGED execVars
  ELSE IF refused[r] /\ RefusalIsConsulted
    THEN UNCHANGED execVars
  ELSE \E eligible \in BOOLEAN :
    IF ~eligible
      THEN \* recordAdmissionRefusal: a Refused Start, and no Execution.
           /\ refused' = [refused EXCEPT ![r] = TRUE]
           /\ eligRefused' = [eligRefused EXCEPT ![r] = TRUE]
           /\ IF ~EligibilityBeforeConcurrency /\ mode = "newest" /\ Live # {}
                THEN Supersede(<<"none">>) /\ refusedChanged' = TRUE
                ELSE UNCHANGED <<exec, esched, refusedChanged>>
           /\ UNCHANGED opened
    ELSE IF mode = "first" /\ Live # {}
      THEN /\ refused' = [refused EXCEPT ![r] = TRUE]
           /\ UNCHANGED <<exec, esched, opened, eligRefused, refusedChanged>>
    ELSE
      /\ exec' = [y \in Execs |->
                   IF y = x THEN "running"
                   ELSE IF y \in Live /\ mode = "newest" THEN "superseded"
                   ELSE exec[y]]
      /\ esched' = [y \in Execs |->
                     IF y = x THEN (IF ExecutionAndScheduleTogether THEN "present" ELSE "none")
                     ELSE IF y \in Live /\ mode = "newest" /\ SupersedeDropsSchedule THEN "gone"
                     ELSE esched[y]]
      /\ opened' = [opened EXCEPT ![k] = @ + 1]
      /\ UNCHANGED <<refused, eligRefused, refusedChanged>>

\* requestCancelForEntity for the Cancel arrival: claim every live run.
CancelWrite ==
  /\ exec' = [y \in Execs |-> IF exec[y] = "running" THEN "claimed" ELSE exec[y]]
  /\ UNCHANGED <<esched, refused, eligRefused, refusedChanged, opened>>

LifecycleStep(w) ==
  /\ pc[w] = "write" /\ LeaseHeldBy(w)
  /\ LET r == cur[w] IN
       /\ IF r[1] = "c" THEN CancelWrite ELSE StartWrite(r)
       /\ written' = [written EXCEPT ![r] = TRUE]
  /\ pc' = [pc EXCEPT ![w] = "memo"]
  /\ UNCHANGED <<mode, sends, inbox, dsched, dholder, memo, cur, faults>>

RecordMemo(w) ==
  /\ pc[w] = "memo" /\ LeaseHeldBy(w)
  /\ memo' = [memo EXCEPT ![cur[w]] = TRUE]
  /\ pc' = [pc EXCEPT ![w] = "finish"]
  /\ UNCHANGED <<mode, sends, inbox, dsched, dholder, written, cur, execVars, faults>>

FinishDelivery(w) ==
  /\ pc[w] = "finish" /\ LeaseHeldBy(w)
  /\ dsched' = [dsched EXCEPT ![cur[w]] = "gone"] /\ dholder' = [dholder EXCEPT ![cur[w]] = 0]
  /\ pc' = [pc EXCEPT ![w] = "idle"]
  /\ UNCHANGED <<mode, sends, inbox, written, memo, cur, execVars, faults>>

-----------------------------------------------------------------------------
(* Faults, and the runs themselves. *)

CrashWorker(w) ==
  /\ pc[w] # "idle" /\ faults < MaxFaults
  /\ pc' = [pc EXCEPT ![w] = "idle"] /\ faults' = faults + 1
  /\ UNCHANGED <<mode, sends, inbox, dsched, dholder, written, memo, cur, execVars>>

\* The lease sweep re-queues a delivery whose holder is no longer working on it.
SweepDelivery(r) ==
  /\ dsched[r] = "leased"
  /\ \/ pc[dholder[r]] = "idle"
     \/ cur[dholder[r]] # r
     \/ faults < MaxFaults
  /\ faults' = IF pc[dholder[r]] = "idle" \/ cur[dholder[r]] # r THEN faults ELSE faults + 1
  /\ dsched' = [dsched EXCEPT ![r] = "queued"] /\ dholder' = [dholder EXCEPT ![r] = 0]
  /\ UNCHANGED <<mode, sends, inbox, written, memo, pc, cur, execVars>>

\* An Execution's run finishes, as the run model describes in full. It runs
\* only while its schedule row exists, which is what a worker claims.
RunCompletes(x) ==
  /\ exec[x] = "running" /\ esched[x] = "present"
  /\ exec' = [exec EXCEPT ![x] = "completed"] /\ esched' = [esched EXCEPT ![x] = "gone"]
  /\ UNCHANGED <<mode, sends, inbox, dsched, dholder, written, memo, pc, cur, refused, eligRefused, refusedChanged,
                 opened, faults>>

RunEndsCanceled(x) ==
  /\ exec[x] = "claimed" /\ esched[x] = "present"
  /\ exec' = [exec EXCEPT ![x] = "canceled"] /\ esched' = [esched EXCEPT ![x] = "gone"]
  /\ UNCHANGED <<mode, sends, inbox, dsched, dholder, written, memo, pc, cur, refused, eligRefused, refusedChanged,
                 opened, faults>>

\* A superseded run that still has a schedule row would be claimed and run on.
SupersededRunRuns(x) ==
  /\ exec[x] = "superseded" /\ esched[x] = "present"
  /\ exec' = [exec EXCEPT ![x] = "completed"] /\ esched' = [esched EXCEPT ![x] = "gone"]
  /\ UNCHANGED <<mode, sends, inbox, dsched, dholder, written, memo, pc, cur, refused, eligRefused, refusedChanged,
                 opened, faults>>

AllDone ==
  /\ \A k \in Arrivals : sends[k] = SendCap(k)
  /\ \A r \in Rows : inbox[r] = "present" => dsched[r] = "gone"
  /\ \A w \in Workers : pc[w] = "idle"
  /\ \A x \in Execs : esched[x] # "present"
  /\ UNCHANGED vars

WorkerStep(w) ==
  \/ \E r \in Rows : ClaimDelivery(w, r)
  \/ DeliveryFenced(w) \/ LifecycleStep(w) \/ RecordMemo(w) \/ FinishDelivery(w)

Next ==
  \/ \E k \in Arrivals : SendViaApp(k) \/ SendInHostTransaction(k)
  \/ \E r \in Rows : PollInbox(r) \/ SweepDelivery(r)
  \/ \E w \in Workers : WorkerStep(w) \/ CrashWorker(w)
  \/ \E x \in Execs : RunCompletes(x) \/ RunEndsCanceled(x) \/ SupersededRunRuns(x)
  \/ AllDone

Spec == Init /\ [][Next]_vars

\* Workers deliver, the poll and the sweep run, and runs finish. Sends are free
\* never to happen.
FairSpec ==
  /\ Spec
  /\ \A w \in Workers : WF_vars(WorkerStep(w))
  /\ \A r \in Rows : WF_vars(PollInbox(r))
                    /\ WF_vars(SweepDelivery(r) /\ (pc[dholder[r]] = "idle" \/ cur[dholder[r]] # r))
  /\ \A x \in Execs : WF_vars(RunCompletes(x)) /\ WF_vars(RunEndsCanceled(x))

-----------------------------------------------------------------------------
(* Rules. *)

\* Sending the same arrival twice puts one row in the inbox.
DuplicateSendIsOneArrival == \A k \in Arrivals : inbox[<<k, 2>>] = "none"

\* Each Start arrival opens at most one Execution, however often its delivery runs.
EachArrivalOpensAtMostOneRun == \A k \in Starts : opened[k] <= 1

\* An arrival's admission is decided once: one Eligibility refused never opens a run.
AdmissionDecidedOnce ==
  \A r \in Rows : eligRefused[r] => \A c \in Copies : exec[<<r[1], r[2], c>>] = "none"

\* An arrival Eligibility refused changes no run: it supersedes nothing.
RefusedArrivalChangesNothing == ~refusedChanged

\* Under one-at-a-time Concurrency, at most one run per Entity is live.
OneLiveRunPerEntity == Cardinality(Live) <= 1

\* Every open Execution has a schedule row, so some worker will run it.
EveryOpenRunIsScheduled ==
  \A x \in Execs : exec[x] \in {"running", "claimed"} => esched[x] = "present"

\* A superseded run does no more work.
SupersededRunsStop == \A x \in Execs : exec[x] = "superseded" => esched[x] # "present"

\* Every arrival in the inbox is delivered.
EveryArrivalIsDelivered == \A r \in Rows : (inbox[r] = "present") ~> (dsched[r] = "gone")

\* Every opened run ends.
EveryRunEnds == \A x \in Execs : (exec[x] \in {"running", "claimed"}) ~> (exec[x] \notin {"running", "claimed"})

ReachSupersede     == \E x \in Execs : exec[x] = "superseded"
ReachEligibilityRefusal == \E r \in Rows : eligRefused[r]
ReachRefusalAnsweredOnRetry == \E r \in Rows : eligRefused[r] /\ written[r] /\ ~memo[r] /\ dsched[r] = "queued"
ReachRefusedStart  == \E r \in Rows : refused[r]
ReachCanceledRun   == \E x \in Execs : exec[x] = "canceled"
ReachRedelivery    == \E r \in Rows : written[r] /\ ~memo[r] /\ dsched[r] = "queued"
ReachHostTransactionDelivered == \E r \in Rows : inbox[r] = "present" /\ dsched[r] = "gone" /\ written[r]
=============================================================================
