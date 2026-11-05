------------------------------- MODULE Timing -------------------------------
(***************************************************************************)
(* Leases, heartbeats, polling, deadlines and the Cloudflare Worker        *)
(* driver's platform limits, with a discrete clock, for the executor       *)
(* proposed in docs/internal/plans/separate-event-intake-from-durable-    *)
(* execution.md ("Lease and liveness", "Wake latency", section 8).         *)
(*                                                                         *)
(* One run does a step, sleeps on a Wait until its deadline, then does a   *)
(* second step. A step takes one unit, or four, which outlasts either     *)
(* driver's lease and fits the Worker budget. Two workers serve            *)
(* it under one of two drivers, chosen per behaviour:                      *)
(*                                                                         *)
(*   node    A long-lived worker loop polls every unit and heartbeats its  *)
(*           lease while a step runs.                                      *)
(*   worker  A Cloudflare Worker invocation starts on a Cron Trigger or a  *)
(*           queue message, heartbeats while it runs, and is killed by the *)
(*           platform at its wall-time budget. A queue message can be      *)
(*           delayed by at most QueueMaxDelay, so a longer sleep is woken  *)
(*           by the cron sweep alone.                                      *)
(*                                                                         *)
(* Anything due at the current instant (a poll, a heartbeat, an expired    *)
(* lease, a kill) happens before time advances. One worker may crash once. *)
(* Units: the node driver's are the design's 20-second heartbeat over a    *)
(* 60-second lease with a 1-second poll; the worker driver's are minutes:  *)
(* a 1-minute cron, a lease and budget in the design's 5:15 ratio, scaled. *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Workers, MaxTime

\* Driver parameters, named so a mutation can change one.
NodeLease == 3
NodeHeartbeat == 1
NodePoll == 1
WorkerLease == 2
WorkerHeartbeat == 1
WorkerCron == 1
WorkerBudget == 6
QueueMaxDelay == 2
WakeAt == 5                     \* the Wait's deadline: longer than QueueMaxDelay
StepTimes == {1, 4}             \* a quick step, and one longer than a lease
WorkerUsesCron == TRUE          \* section 8: a Cron Trigger sweeps due rows every minute
ClaimWaitsForTheDeadline == TRUE \* the claim's `wake_at <= now()`

VARIABLES
  now,
  driver,       \* "node" | "worker"
  sched,        \* "queued" | "leased" | "waiting" | "gone"
  phase,        \* the run: "first" step, "parked", "second" step, "done"
  holder,       \* the worker holding the lease, 0 for none
  leaseUntil,   \* when the lease expires
  busy,         \* each worker: time units of step work left, 0 when idle
  beat,         \* each worker: when it last renewed its lease
  started,      \* each worker: when its Worker invocation started
  alive,        \* each worker: not crashed or killed
  queueAt,      \* when a queue message wakes the run, 0 for none
  parkedAt,     \* when the run parked on its Wait
  crashed,      \* whether the one allowed crash has happened
  deadSince,    \* when the lease holder died, 0 while it lives
  liveExpired,  \* a lease expired under a live, heartbeating worker
  earlyResume   \* the Wait resumed before its deadline

vars == <<now, driver, sched, phase, holder, leaseUntil, busy, beat, started, alive,
          queueAt, parkedAt, crashed, deadSince, liveExpired, earlyResume>>

\* The parameters of the driver this behaviour runs.
Lease == IF driver = "node" THEN NodeLease ELSE WorkerLease
Heartbeat == IF driver = "node" THEN NodeHeartbeat ELSE WorkerHeartbeat
Interval == IF driver = "node" THEN NodePoll ELSE WorkerCron

Init ==
  /\ now = 0 /\ driver \in {"node", "worker"}
  /\ sched = "queued" /\ phase = "first" /\ holder = 0 /\ leaseUntil = 0
  /\ busy = [w \in Workers |-> 0] /\ beat = [w \in Workers |-> 0]
  /\ started = [w \in Workers |-> 0] /\ alive = [w \in Workers |-> TRUE]
  /\ queueAt = 0 /\ parkedAt = 0 /\ crashed = FALSE /\ deadSince = 0
  /\ liveExpired = FALSE /\ earlyResume = FALSE

-----------------------------------------------------------------------------
(* What may happen at the current instant. *)

\* The run is due: queued, or sleeping past its deadline.
Due == sched = "queued" \/ (sched = "waiting" /\ (now >= WakeAt \/ ~ClaimWaitsForTheDeadline))

\* A worker looks for due rows now: every poll for the node driver; on a cron
\* tick or a queue message for the Worker driver.
Polls(w) ==
  /\ alive[w] /\ busy[w] = 0 /\ holder # w
  /\ IF driver = "node" THEN now % NodePoll = 0
     \* A queued run also has a queue message: a send or a re-queue enqueues one.
     ELSE \/ WorkerUsesCron /\ now % WorkerCron = 0
          \/ sched = "queued"
          \/ queueAt # 0 /\ now >= queueAt

ClaimRun(w) ==
  /\ Polls(w) /\ Due /\ sched # "leased"
  /\ earlyResume' = (earlyResume \/ (sched = "waiting" /\ now < WakeAt))
  /\ sched' = "leased" /\ holder' = w /\ leaseUntil' = now + Lease
  /\ phase' = IF phase = "parked" THEN "second" ELSE phase
  /\ \E d \in StepTimes : busy' = [busy EXCEPT ![w] = d]
  /\ beat' = [beat EXCEPT ![w] = now] /\ started' = [started EXCEPT ![w] = now]
  /\ queueAt' = IF queueAt # 0 /\ now >= queueAt THEN 0 ELSE queueAt
  /\ deadSince' = 0
  /\ UNCHANGED <<now, driver, alive, parkedAt, crashed, liveExpired>>

HeartbeatDue(w) == alive[w] /\ holder = w /\ busy[w] > 0 /\ now - beat[w] >= Heartbeat

DoHeartbeat(w) ==
  /\ HeartbeatDue(w)
  /\ leaseUntil' = now + Lease /\ beat' = [beat EXCEPT ![w] = now]
  /\ UNCHANGED <<now, driver, sched, phase, holder, busy, started, alive, queueAt, parkedAt, crashed,
                 deadSince, liveExpired, earlyResume>>

\* The step's work is done: release the run, parked until its deadline or done.
FinishDue(w) == alive[w] /\ holder = w /\ busy[w] = 0 /\ sched = "leased"

FinishStep(w) ==
  /\ FinishDue(w)
  /\ holder' = 0
  /\ IF phase = "first"
       THEN /\ phase' = "parked" /\ sched' = "waiting" /\ parkedAt' = now
            \* A queue message is sent for a deadline within the delay cap.
            /\ queueAt' = IF WakeAt - now <= QueueMaxDelay THEN WakeAt ELSE 0
       ELSE /\ phase' = "done" /\ sched' = "gone" /\ UNCHANGED <<queueAt, parkedAt>>
  /\ UNCHANGED <<now, driver, leaseUntil, busy, beat, started, alive, crashed, deadSince,
                 liveExpired, earlyResume>>

\* The lease sweep: an expired lease puts the run back in the queue.
SweepLateness == 0              \* the sweep expires a lease the moment it runs out
ExpiryDue == sched = "leased" /\ now >= leaseUntil + SweepLateness

Expire ==
  /\ ExpiryDue
  /\ liveExpired' = (liveExpired \/ (holder # 0 /\ alive[holder] /\ busy[holder] > 0))
  /\ sched' = "queued" /\ holder' = 0
  /\ UNCHANGED <<now, driver, phase, leaseUntil, busy, beat, started, alive, queueAt, parkedAt,
                 crashed, deadSince, earlyResume>>

\* The Worker platform kills an invocation at its wall-time budget.
KillDue(w) == driver = "worker" /\ alive[w] /\ busy[w] > 0 /\ now - started[w] >= WorkerBudget

\* The run's lease outlives the killed invocation: the row stays leased to an
\* invocation that no longer exists (holder 0) until the sweep expires it. The
\* worker slot itself is free for the next invocation.
Kill(w) ==
  /\ KillDue(w)
  /\ busy' = [busy EXCEPT ![w] = 0]
  /\ deadSince' = IF holder = w THEN now ELSE deadSince
  /\ holder' = IF holder = w THEN 0 ELSE holder
  /\ UNCHANGED <<now, driver, sched, phase, leaseUntil, beat, started, alive, queueAt, parkedAt, crashed,
                 liveExpired, earlyResume>>

\* One worker may crash once, holding its lease.
Crash(w) ==
  /\ ~crashed /\ alive[w] /\ busy[w] > 0
  /\ alive' = [alive EXCEPT ![w] = FALSE] /\ busy' = [busy EXCEPT ![w] = 0]
  /\ crashed' = TRUE /\ deadSince' = IF holder = w THEN now ELSE deadSince
  /\ UNCHANGED <<now, driver, sched, phase, holder, leaseUntil, beat, started, queueAt, parkedAt,
                 liveExpired, earlyResume>>

Urgent ==
  \/ \E w \in Workers : (Polls(w) /\ Due /\ sched # "leased") \/ HeartbeatDue(w)
                        \/ FinishDue(w) \/ KillDue(w)
  \/ ExpiryDue

\* Time advances when nothing is due now. A step's work counts down.
Tick ==
  /\ now < MaxTime /\ ~Urgent
  /\ now' = now + 1
  /\ busy' = [w \in Workers |-> IF busy[w] > 0 THEN busy[w] - 1 ELSE 0]
  /\ UNCHANGED <<driver, sched, phase, holder, leaseUntil, beat, started, alive, queueAt, parkedAt,
                 crashed, deadSince, liveExpired, earlyResume>>

\* The clock stops at MaxTime, which is past the latest end of any run.
Stop == now = MaxTime /\ ~Urgent /\ UNCHANGED vars

Next ==
  \/ \E w \in Workers : ClaimRun(w) \/ DoHeartbeat(w) \/ FinishStep(w) \/ Kill(w) \/ Crash(w)
  \/ Expire \/ Tick \/ Stop

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Rules. *)

\* A Wait never resumes before its deadline.
NoResumeBeforeTheDeadline == ~earlyResume

\* A sleeping run is picked up within one poll or cron interval of its deadline,
\* or of the moment it parked when that came after the deadline.
DeadlineHonouredOnTime ==
  sched = "waiting" => now <= (IF parkedAt > WakeAt THEN parkedAt ELSE WakeAt) + Interval

\* A lease never expires under a live worker that is heartbeating through a step.
LiveLeaseNeverExpires == ~liveExpired

\* A run whose worker died or was killed is picked up again within one lease and
\* one interval.
DeadWorkerRecoveredInTime == deadSince # 0 => now <= deadSince + Lease + Interval

\* Every run ends before the clock stops.
EveryRunEndsInTime == now = MaxTime => sched = "gone"

ReachNodeDone       == driver = "node" /\ phase = "done"
ReachWorkerDone     == driver = "worker" /\ phase = "done"
ReachCrashRecovered == crashed /\ phase = "done"
ReachCronWake       == driver = "worker" /\ phase = "second" /\ queueAt = 0
=============================================================================
