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
(*                                                                         *)
(* The retention sweeps delete rows at any moment, since a host's two      *)
(* windows are independent and either can be short: the inbox sweep a     *)
(* settled inbox row, the run sweep an ended Execution, and the audit      *)
(* sweep a recorded refusal. The run and audit sweeps each keep a row while *)
(* the inbox row of the arrival it answers for exists, which is what a     *)
(* redelivery of that row reads in place of deciding again. A send whose   *)
(* key a swept row held inserts a new row under a new id.                  *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Workers, MaxFaults

Starts   == {"s1", "s2"}
Arrivals == Starts \cup {"c"}
Copies   == {1, 2}                    \* an inbox row for a key, and a second row for it

\* How many times the host sends each arrival: "s1" twice, to exercise the
\* inbox key, and the others once.
SendCap(k) == IF k = "s1" THEN 2 ELSE 1
Rows     == Arrivals \X Copies         \* inbox row ids
Execs    == Starts \X Copies \X Copies \* Execution ids: the inbox row, and a second insert

VARIABLES
  mode,         \* Concurrency of this workflow: "newest" | "first"
  sends,        \* host sends per arrival
  inbox,        \* each inbox row: "none" | "present" | "swept"
  failed,       \* each inbox row: its delivery failed for good (a refused payload or spent retries)
  dsched,       \* each delivery's schedule row: "none" | "queued" | "leased" | "gone"
  dholder,      \* each delivery's lease holder, 0 for none
  written,      \* each delivery: its lifecycle step's write has committed
  memo,         \* each delivery: its lifecycle step's memo row exists
  pc,           \* each worker: "idle" | "write" | "memo" | "finish"
  cur,          \* each worker: the delivery its pass is on
  exec,         \* each Execution: "none" | "running" | "claimed" | "completed"
                \*   | "canceled" | "superseded" | "swept" (the run sweep deleted it)
  esched,       \* each Execution's schedule row: "none" | "present" | "gone"
  refused,      \* each inbox row of a Start arrival: its Refused Start's audit row exists
  eligRefused,  \* each inbox row: refused by admission Entity Eligibility
  refusedChanged, \* an arrival Eligibility refused changed a run anyway
  faults,
  cancelSet,    \* the runs the Cancel arrival's first write claimed
  lostResend    \* a resend of a failed key answered duplicate and left the row failed

vars == <<mode, sends, inbox, failed, cancelSet, lostResend, dsched, dholder, written, memo, pc, cur, exec, esched,
          refused, eligRefused, refusedChanged, faults>>

\* The guards the design depends on.
InboxKeyIsUnique == TRUE                 \* unique (name, idempotency_key) on the inbox
FailRecordsTheRow == TRUE                \* failDelivery marks the inbox row failed with the schedule row's deletion
ResendRedeliversFailed == TRUE           \* a send whose key holds a failed row resets it to pending and schedules it
CancelDecisionIsRecorded == TRUE         \* a Cancel's claim records its decision, and a retried claim answers from it
DeliveryIdIsUnique == TRUE               \* unique (workflow_id, delivery_id) on executions
RefusalIsConsulted == TRUE               \* answerFromCommittedDecision reads a prior refusal first
EligibilityBeforeConcurrency == TRUE     \* Precedence: admission Eligibility, then Concurrency
ExecutionAndScheduleTogether == TRUE     \* one transaction inserts both rows
SupersedeDropsSchedule == TRUE           \* a supersede deletes the run's schedule row
RunSweepKeepsInboxRuns == TRUE           \* sweepableExecution: the run's inbox row is gone
AuditSweepKeepsInboxRefusals == TRUE     \* sweepableWorkflowAudit: the refusal's inbox row is gone
LeaseHeldBy(w) == dholder[cur[w]] = w

Live == {x \in Execs : exec[x] = "running"}

Init ==
  /\ mode \in {"newest", "first"}
  /\ sends = [k \in Arrivals |-> 0]
  /\ inbox = [r \in Rows |-> "none"] /\ dsched = [r \in Rows |-> "none"]
  /\ failed = [r \in Rows |-> FALSE] /\ cancelSet = {} /\ lostResend = FALSE
  /\ dholder = [r \in Rows |-> 0]
  /\ written = [r \in Rows |-> FALSE] /\ memo = [r \in Rows |-> FALSE]
  /\ pc = [w \in Workers |-> "idle"] /\ cur = [w \in Workers |-> <<"c", 1>>]
  /\ exec = [x \in Execs |-> "none"] /\ esched = [x \in Execs |-> "none"]
  /\ refused = [r \in Rows |-> FALSE] /\ faults = 0
  /\ eligRefused = [r \in Rows |-> FALSE] /\ refusedChanged = FALSE

execVars == <<exec, esched, refused, eligRefused, refusedChanged>>

-----------------------------------------------------------------------------
(* Sources, section 7.3. *)

\* The inbox row a send writes: the key's existing row when the key is unique,
\* and a row under a new id when the retention sweep deleted the key's row.
NewRow(k) ==
  IF inbox[<<k, 1>>] = "none" THEN <<k, 1>>
  ELSE IF inbox[<<k, 1>>] = "present" /\ InboxKeyIsUnique THEN <<k, 1>> ELSE <<k, 2>>

\* app.events.send: the inbox row and its delivery's schedule row in one transaction.
SendViaApp(k) ==
  /\ sends[k] < SendCap(k)
  /\ LET r == NewRow(k) IN
       /\ sends' = [sends EXCEPT ![k] = @ + 1]
       /\ CASE inbox[r] = "none" ->
                 /\ inbox' = [inbox EXCEPT ![r] = "present"]
                 /\ dsched' = [dsched EXCEPT ![r] = "queued"]
                 /\ UNCHANGED <<failed, lostResend>>
            [] failed[r] /\ ResendRedeliversFailed ->
                 /\ failed' = [failed EXCEPT ![r] = FALSE]
                 /\ dsched' = [dsched EXCEPT ![r] = "queued"]
                 /\ UNCHANGED <<inbox, lostResend>>
            [] failed[r] ->
                 /\ lostResend' = TRUE
                 /\ UNCHANGED <<inbox, dsched, failed>>
            [] OTHER -> UNCHANGED <<inbox, dsched, failed, lostResend>>
  /\ UNCHANGED <<mode, dholder, written, memo, pc, cur, execVars, faults, cancelSet>>

\* The host's own transaction inserts the inbox row; its delivery waits for the poll.
SendInHostTransaction(k) ==
  /\ sends[k] < SendCap(k)
  /\ LET r == NewRow(k) IN
       /\ sends' = [sends EXCEPT ![k] = @ + 1]
       /\ inbox' = [inbox EXCEPT ![r] = "present"]
  /\ UNCHANGED <<mode, dsched, dholder, written, memo, pc, cur, execVars, faults, failed, cancelSet, lostResend>>

\* The poll schedules the delivery of an inbox row that has none.
PollInbox(r) ==
  /\ inbox[r] = "present" /\ dsched[r] = "none"
  /\ dsched' = [dsched EXCEPT ![r] = "queued"]
  /\ UNCHANGED <<mode, sends, inbox, dholder, written, memo, pc, cur, execVars, faults, failed, cancelSet, lostResend>>

-----------------------------------------------------------------------------
(* Delivery, section 7.2. *)

ClaimDelivery(w, r) ==
  /\ pc[w] = "idle" /\ dsched[r] = "queued"
  /\ dsched' = [dsched EXCEPT ![r] = "leased"] /\ dholder' = [dholder EXCEPT ![r] = w]
  /\ cur' = [cur EXCEPT ![w] = r]
  /\ pc' = [pc EXCEPT ![w] = IF memo[r] THEN "finish" ELSE "write"]
  /\ UNCHANGED <<mode, sends, inbox, written, memo, execVars, faults, failed, cancelSet, lostResend>>

DeliveryFenced(w) ==
  /\ pc[w] # "idle" /\ ~LeaseHeldBy(w)
  /\ pc' = [pc EXCEPT ![w] = "idle"]
  /\ UNCHANGED <<mode, sends, inbox, dsched, dholder, written, memo, cur, execVars, faults, failed, cancelSet, lostResend>>

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
  \* findByDelivery finds the run unless the run sweep deleted it.
  IF exec[first] \notin {"none", "swept"} /\ DeliveryIdIsUnique
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
                ELSE UNCHANGED <<exec, esched, refusedChanged, failed, cancelSet, lostResend>>
    ELSE IF mode = "first" /\ Live # {}
      THEN /\ refused' = [refused EXCEPT ![r] = TRUE]
           /\ UNCHANGED <<exec, esched, eligRefused, refusedChanged, failed, cancelSet, lostResend>>
    ELSE
      /\ exec' = [y \in Execs |->
                   IF y = x THEN "running"
                   ELSE IF y \in Live /\ mode = "newest" THEN "superseded"
                   ELSE exec[y]]
      /\ esched' = [y \in Execs |->
                     IF y = x THEN (IF ExecutionAndScheduleTogether THEN "present" ELSE "none")
                     ELSE IF y \in Live /\ mode = "newest" /\ SupersedeDropsSchedule THEN "gone"
                     ELSE esched[y]]
      /\ UNCHANGED <<refused, eligRefused, refusedChanged, failed, cancelSet, lostResend>>

\* requestCancelForEntity for the Cancel arrival. Its first write claims every
\* live run and records that decision; a write run again after a crash
\* answers from the recorded decision and claims nothing new.
CancelWrite(r) ==
  /\ IF written[r] /\ CancelDecisionIsRecorded
       THEN UNCHANGED <<exec, cancelSet>>
       ELSE /\ exec' = [y \in Execs |-> IF exec[y] = "running" THEN "claimed" ELSE exec[y]]
            /\ cancelSet' = IF written[r] THEN cancelSet
                            ELSE {y \in Execs : exec[y] = "running"}
  /\ UNCHANGED <<esched, refused, eligRefused, refusedChanged, failed, lostResend>>

LifecycleStep(w) ==
  /\ pc[w] = "write" /\ LeaseHeldBy(w)
  /\ LET r == cur[w] IN
       /\ IF r[1] = "c" THEN CancelWrite(r) ELSE StartWrite(r) /\ UNCHANGED cancelSet
       /\ written' = [written EXCEPT ![r] = TRUE]
  /\ pc' = [pc EXCEPT ![w] = "memo"]
  /\ UNCHANGED <<mode, sends, inbox, dsched, dholder, memo, cur, faults, failed, lostResend>>

RecordMemo(w) ==
  /\ pc[w] = "memo" /\ LeaseHeldBy(w)
  /\ memo' = [memo EXCEPT ![cur[w]] = TRUE]
  /\ pc' = [pc EXCEPT ![w] = "finish"]
  /\ UNCHANGED <<mode, sends, inbox, dsched, dholder, written, cur, execVars, faults, failed, cancelSet, lostResend>>

FinishDelivery(w) ==
  /\ pc[w] = "finish" /\ LeaseHeldBy(w)
  /\ dsched' = [dsched EXCEPT ![cur[w]] = "gone"] /\ dholder' = [dholder EXCEPT ![cur[w]] = 0]
  /\ pc' = [pc EXCEPT ![w] = "idle"]
  /\ UNCHANGED <<mode, sends, inbox, written, memo, cur, execVars, faults, failed, cancelSet, lostResend>>

\* The delivery fails for good: its payload is refused or its retries are spent.
\* failDelivery records the inbox row as failed in the transaction that deletes
\* its schedule row, so the poll never schedules it again. Without that record
\* the row would read as one a host inserted and the poll would deliver it again.
FailDelivery(w) ==
  /\ pc[w] = "write" /\ LeaseHeldBy(w) /\ ~failed[cur[w]]
  /\ failed' = [failed EXCEPT ![cur[w]] = TRUE]
  /\ dsched' = [dsched EXCEPT ![cur[w]] = IF FailRecordsTheRow THEN "gone" ELSE "none"]
  /\ dholder' = [dholder EXCEPT ![cur[w]] = 0]
  /\ pc' = [pc EXCEPT ![w] = "idle"]
  /\ UNCHANGED <<mode, sends, inbox, written, memo, cur, execVars, faults, cancelSet, lostResend>>

-----------------------------------------------------------------------------
(* Faults, and the runs themselves. *)

CrashWorker(w) ==
  /\ pc[w] # "idle" /\ faults < MaxFaults
  /\ pc' = [pc EXCEPT ![w] = "idle"] /\ faults' = faults + 1
  /\ UNCHANGED <<mode, sends, inbox, dsched, dholder, written, memo, cur, execVars, failed, cancelSet, lostResend>>

\* The lease sweep re-queues a delivery whose holder is no longer working on it.
SweepDelivery(r) ==
  /\ dsched[r] = "leased"
  /\ \/ pc[dholder[r]] = "idle"
     \/ cur[dholder[r]] # r
     \/ faults < MaxFaults
  /\ faults' = IF pc[dholder[r]] = "idle" \/ cur[dholder[r]] # r THEN faults ELSE faults + 1
  /\ dsched' = [dsched EXCEPT ![r] = "queued"] /\ dholder' = [dholder EXCEPT ![r] = 0]
  /\ UNCHANGED <<mode, sends, inbox, written, memo, pc, cur, execVars, failed, cancelSet, lostResend>>

\* An Execution's run finishes, as the run model describes in full. It runs
\* only while its schedule row exists, which is what a worker claims.
RunCompletes(x) ==
  /\ exec[x] = "running" /\ esched[x] = "present"
  /\ exec' = [exec EXCEPT ![x] = "completed"] /\ esched' = [esched EXCEPT ![x] = "gone"]
  /\ UNCHANGED <<mode, sends, inbox, dsched, dholder, written, memo, pc, cur, refused, eligRefused, refusedChanged,
                 faults, failed, cancelSet, lostResend>>

RunEndsCanceled(x) ==
  /\ exec[x] = "claimed" /\ esched[x] = "present"
  /\ exec' = [exec EXCEPT ![x] = "canceled"] /\ esched' = [esched EXCEPT ![x] = "gone"]
  /\ UNCHANGED <<mode, sends, inbox, dsched, dholder, written, memo, pc, cur, refused, eligRefused, refusedChanged,
                 faults, failed, cancelSet, lostResend>>

\* A superseded run that still has a schedule row would be claimed and run on.
SupersededRunRuns(x) ==
  /\ exec[x] = "superseded" /\ esched[x] = "present"
  /\ exec' = [exec EXCEPT ![x] = "completed"] /\ esched' = [esched EXCEPT ![x] = "gone"]
  /\ UNCHANGED <<mode, sends, inbox, dsched, dholder, written, memo, pc, cur, refused, eligRefused, refusedChanged,
                 faults, failed, cancelSet, lostResend>>

-----------------------------------------------------------------------------
(* Retention, decisions 7 and 8. Each sweep deletes a row whenever its guard *)
(* allows, which stands for every choice of window and every batch order.   *)

\* sweepSettledInbox: a delivered or failed row (sweepableInbox). A pending row
\* is never swept. The row's schedule row is already gone. The model sweeps the
\* row of "s2" alone, the Start sent once, which keeps the state count near the
\* largest model's:
\*   - A send after the sweep is a new arrival under a new id (ADR-0022), which
\*     doubles the state space and checks nothing a first arrival does not, so
\*     the twice-sent "s1" is not swept.
\*   - A Cancel arrival's row answers a redelivery from its
\*     workflow_cancel_decisions row, which goes with the inbox row by cascade,
\*     so sweeping it changes nothing a rule reads.
\* The run and audit sweeps take any row their guard allows, so a mutation that
\* drops a guard deletes the records of "s1" while its row is pending or failed.
SweepInbox(r) ==
  /\ r[1] = "s2" /\ sends[r[1]] = SendCap(r[1])
  /\ inbox[r] = "present" /\ dsched[r] = "gone"
  /\ inbox' = [inbox EXCEPT ![r] = "swept"]
  /\ UNCHANGED <<mode, sends, failed, dsched, dholder, written, memo, pc, cur, execVars, faults, cancelSet,
                 lostResend>>

\* sweepEndedExecutions: an Execution with a terminal status, which the run
\* sweep keeps while the inbox row that opened it exists (sweepableExecution).
SweepRun(x) ==
  /\ exec[x] \in {"completed", "canceled", "superseded"}
  /\ RunSweepKeepsInboxRuns => inbox[<<x[1], x[2]>>] # "present"
  /\ exec' = [exec EXCEPT ![x] = "swept"]
  /\ UNCHANGED <<mode, sends, inbox, failed, dsched, dholder, written, memo, pc, cur, esched, refused,
                 eligRefused, refusedChanged, faults, cancelSet, lostResend>>

\* sweepWorkflowAuditEvents: a Refused Start's workflow audit row, which the
\* audit sweep keeps while the inbox row its metadata names exists
\* (sweepableWorkflowAudit). The Entity admission refusal findAdmissionRefusal
\* reads is one of these rows.
SweepRefusal(r) ==
  /\ refused[r]
  /\ AuditSweepKeepsInboxRefusals => inbox[r] # "present"
  /\ refused' = [refused EXCEPT ![r] = FALSE]
  /\ UNCHANGED <<mode, sends, inbox, failed, dsched, dholder, written, memo, pc, cur, exec, esched,
                 eligRefused, refusedChanged, faults, cancelSet, lostResend>>

AllDone ==
  /\ \A k \in Arrivals : sends[k] = SendCap(k)
  /\ \A r \in Rows : inbox[r] = "present" => dsched[r] = "gone"
  /\ \A w \in Workers : pc[w] = "idle"
  /\ \A x \in Execs : esched[x] # "present"
  /\ UNCHANGED vars

WorkerStep(w) ==
  \/ \E r \in Rows : ClaimDelivery(w, r)
  \/ DeliveryFenced(w) \/ LifecycleStep(w) \/ RecordMemo(w) \/ FinishDelivery(w)
  \/ FailDelivery(w)

Next ==
  \/ \E k \in Arrivals : SendViaApp(k) \/ SendInHostTransaction(k)
  \/ \E r \in Rows : PollInbox(r) \/ SweepDelivery(r)
  \/ \E w \in Workers : WorkerStep(w) \/ CrashWorker(w)
  \/ \E x \in Execs : RunCompletes(x) \/ RunEndsCanceled(x) \/ SupersededRunRuns(x) \/ SweepRun(x)
  \/ \E r \in Rows : SweepInbox(r) \/ SweepRefusal(r)
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

\* Sending the same arrival twice puts one row in the inbox: two rows never
\* hold one key. A send after the retention sweep deleted the key's row is a
\* new arrival (ADR-0022).
DuplicateSendIsOneArrival == \A k \in Arrivals : ~(inbox[<<k, 1>>] = "present" /\ inbox[<<k, 2>>] = "present")

\* No inbox row ever has two Executions, however often its delivery runs and
\* whatever the retention sweeps delete: an Execution the run sweep deleted
\* still counts.
OneRunPerInboxRow ==
  \A k \in Starts, i \in Copies : \A c \in Copies :
    exec[<<k, i, c>>] # "none" => \A d \in Copies \ {c} : exec[<<k, i, d>>] = "none"

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

\* A Cancel arrival claims only the runs that were live when its claim first
\* committed, however often its delivery runs the claim.
CancelClaimsOnlyEarlierRuns ==
  \A y \in Execs : exec[y] \in {"claimed", "canceled"} => y \in cancelSet

\* A resend of a key whose delivery failed is delivered again, not answered
\* as a duplicate of the failed row.
NoResendOfAFailedKeyIsLost == ~lostResend

\* A delivery that failed for good stays settled: nothing but a resend of its
\* key schedules it again.
FailedArrivalStaysSettled == \A r \in Rows : failed[r] => dsched[r] = "gone"

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
ReachResentAfterFailure == \E r \in Rows : r[1] = "s1" /\ ~failed[r] /\ dsched[r] = "gone" /\ sends["s1"] = 2 /\ written[r]
ReachFailedDelivery == \E r \in Rows : failed[r] /\ dsched[r] = "gone"
ReachHostTransactionDelivered == \E r \in Rows : inbox[r] = "present" /\ dsched[r] = "gone" /\ written[r]
\* An ended run whose inbox row may still be delivered again: pending through a
\* retry, or failed with a resend of its key still to come.
EndedRunOf(r) ==
  /\ r[1] \in Starts
  /\ exec[<<r[1], r[2], 1>>] \in {"completed", "canceled", "superseded"} /\ inbox[r] = "present"
ReachRunKeptForARetry        == \E r \in Rows : EndedRunOf(r) /\ dsched[r] = "queued" /\ written[r] /\ ~memo[r]
ReachRunKeptForAResend       == EndedRunOf(<<"s1", 1>>) /\ failed[<<"s1", 1>>] /\ sends["s1"] = 1
ReachRunSwept                == \E x \in Execs : exec[x] = "swept"
ReachRefusalSwept            == \E r \in Rows : eligRefused[r] /\ ~refused[r]=============================================================================
