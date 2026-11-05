------------------------------ MODULE Arrivals ------------------------------
(***************************************************************************)
(* Two arrivals of Event X delivered at the same time to one workflow, and *)
(* each Wait's match expression, under the executor proposed in            *)
(* docs/internal/plans/separate-event-intake-from-durable-execution.md     *)
(* (section 7.2, "Resolving a park") and today's resumeWaitsMatchingEvent. *)
(*                                                                         *)
(* The workflow has two runs parked on X. Run R waits at row "w1", and once *)
(* woken it parks again on X at row "w2". Run Q waits at row "q". Each Wait *)
(* has a match that accepts some payloads; arrival "x1" carries payload "a" *)
(* and "x2" carries "b". A Migration may re-park "q" once, with a new match *)
(* and a new token, at any time it is waiting.                             *)
(*                                                                         *)
(* Each arrival's delivery saves its candidates with the token and match   *)
(* each row had when it was scanned, then offers them in order. An offer   *)
(* evaluates the saved match and claims the row with the saved token. When *)
(* the claim finds the token rotated, the delivery re-reads the row and,   *)
(* if the row is still waiting with no other arrival recorded, evaluates   *)
(* the current match and claims with the current token. A crash between    *)
(* an offer and its memo row offers the same candidate again.              *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS Workers, MaxFaults

ArrivalIds == {"x1", "x2"}
Payload == [a \in ArrivalIds |-> IF a = "x1" THEN "a" ELSE "b"]
Rows == <<"w1", "q", "w2">>                 \* in id order; w2 is created later
RowSet == {"w1", "q", "w2"}
RunOf == [r \in RowSet |-> IF r = "q" THEN "Q" ELSE "R"]
Payloads == {"a", "b"}

VARIABLES
  dsched,     \* each arrival's delivery schedule row: "queued" | "leased" | "gone"
  holder,     \* each arrival's lease holder, 0 for none
  faults,
  pc,         \* each worker: <<stage, arrival>>, stage "idle" with no pass
  scannedOk,  \* each arrival: its candidate pages are saved
  pages,      \* each arrival: <<row, token, match>> for each candidate, in order
  offered,    \* each arrival: how many saved candidates have been offered and recorded
  row,        \* each wait row: "none" | "waiting" | "woken"
  token,      \* each wait row's current resume token
  match,      \* each wait row's current match: the payloads it accepts
  arrival,    \* each wait row: the arrival that claimed it, or "none"
  reparked,   \* whether the Migration has re-parked "q"
  wakes,      \* each wait row: how many times an arrival woke it
  wrongWake,  \* an arrival woke a row whose match in force did not accept it
  missed      \* an arrival left a waiting row unclaimed that its match in force accepted

vars == <<dsched, holder, faults, pc, scannedOk, pages, offered, row, token, match,
          arrival, reparked, wakes, wrongWake, missed>>

\* The guards the design depends on.
ClaimNeedsTheToken == TRUE      \* claimWaitingStateById requires the park's token
RefreshOnRotatedToken == TRUE   \* canRefreshWaitCandidate re-reads a rotated park
RowIsWaiting(r) == row[r] = "waiting"   \* claimWaitState: `status = 'waiting'`
LeaseHeldBy(w) == holder[pc[w][2]] = w

Init ==
  /\ dsched = [a \in ArrivalIds |-> "queued"] /\ holder = [a \in ArrivalIds |-> 0]
  /\ faults = 0
  /\ pc = [w \in Workers |-> <<"idle", "x1">>]
  /\ scannedOk = [a \in ArrivalIds |-> FALSE] /\ pages = [a \in ArrivalIds |-> <<>>]
  /\ offered = [a \in ArrivalIds |-> 0]
  /\ row = [r \in RowSet |-> IF r = "w2" THEN "none" ELSE "waiting"]
  /\ token = [r \in RowSet |-> 1]
  /\ \E m1, mq \in SUBSET Payloads :
       match = [r \in RowSet |-> CASE r = "w1" -> m1 [] r = "q" -> mq [] OTHER -> {}]
  /\ arrival = [r \in RowSet |-> "none"]
  /\ reparked = FALSE
  /\ wakes = [r \in RowSet |-> 0] /\ wrongWake = FALSE /\ missed = FALSE

shared == <<row, token, match, arrival, reparked, wakes, wrongWake, missed>>

-----------------------------------------------------------------------------
(* Each arrival's delivery. *)

Claim(w, a) ==
  /\ pc[w][1] = "idle" /\ dsched[a] = "queued"
  /\ dsched' = [dsched EXCEPT ![a] = "leased"] /\ holder' = [holder EXCEPT ![a] = w]
  /\ pc' = [pc EXCEPT ![w] = <<"scan", a>>]
  /\ UNCHANGED <<faults, scannedOk, pages, offered, shared>>

Fenced(w) ==
  /\ pc[w][1] # "idle" /\ ~LeaseHeldBy(w)
  /\ pc' = [pc EXCEPT ![w] = <<"idle", "x1">>]
  /\ UNCHANGED <<dsched, holder, faults, scannedOk, pages, offered, shared>>

Snapshot(r) == <<r, token[r], match[r]>>

Scan(w) ==
  /\ pc[w][1] = "scan" /\ LeaseHeldBy(w)
  /\ LET a == pc[w][2] IN
     /\ IF scannedOk[a] THEN UNCHANGED <<scannedOk, pages>>
        ELSE /\ scannedOk' = [scannedOk EXCEPT ![a] = TRUE]
             /\ pages' = [pages EXCEPT ![a] =
                  [i \in 1..Len(SelectSeq(Rows, LAMBDA r : row[r] = "waiting")) |->
                     Snapshot(SelectSeq(Rows, LAMBDA r : row[r] = "waiting")[i])]]
     /\ pc' = [pc EXCEPT ![w] = <<"offer", a>>]
  /\ UNCHANGED <<dsched, holder, faults, offered, shared>>

\* A claim: the row is still waiting, holds the token offered, and has no other
\* arrival recorded. It records the arrival and wakes the row.
CanClaim(r, t, a) ==
  /\ RowIsWaiting(r)
  /\ (~ClaimNeedsTheToken \/ token[r] = t)
  /\ arrival[r] \in {"none", a}

DoClaim(r, a, accepted) ==
  /\ row' = [row EXCEPT ![r] = "woken"] /\ arrival' = [arrival EXCEPT ![r] = a]
  /\ wakes' = [wakes EXCEPT ![r] = @ + 1]
  /\ wrongWake' = (wrongWake \/ Payload[a] \notin accepted)
  /\ UNCHANGED missed

\* Offer one saved candidate, as resumeOneWait does.
OfferOne(a, cand) ==
  LET r == cand[1]  t == cand[2]  m == cand[3] IN
  IF Payload[a] \notin m THEN UNCHANGED <<row, arrival, wakes, wrongWake, missed>>
  ELSE IF CanClaim(r, t, a) THEN DoClaim(r, a, match[r])
  ELSE IF /\ RefreshOnRotatedToken
          /\ row[r] = "waiting" /\ token[r] # t /\ arrival[r] \in {"none", a}
       THEN IF Payload[a] \in match[r] THEN DoClaim(r, a, match[r])
            ELSE UNCHANGED <<row, arrival, wakes, wrongWake, missed>>
  ELSE /\ missed' = (missed \/ (row[r] = "waiting" /\ arrival[r] = "none" /\ Payload[a] \in match[r]))
       /\ UNCHANGED <<row, arrival, wakes, wrongWake>>

Offer(w) ==
  /\ pc[w][1] = "offer" /\ LeaseHeldBy(w)
  /\ LET a == pc[w][2] IN
     IF offered[a] < Len(pages[a])
       THEN /\ OfferOne(a, pages[a][offered[a] + 1])
            /\ pc' = [pc EXCEPT ![w] = <<"record", a>>]
       ELSE /\ pc' = [pc EXCEPT ![w] = <<"finish", a>>]
            /\ UNCHANGED <<row, arrival, wakes, wrongWake, missed>>
  /\ UNCHANGED <<dsched, holder, faults, scannedOk, pages, offered, token, match, reparked>>

\* The page step's memo row, in a transaction of its own.
Record(w) ==
  /\ pc[w][1] = "record" /\ LeaseHeldBy(w)
  /\ offered' = [offered EXCEPT ![pc[w][2]] = @ + 1]
  /\ pc' = [pc EXCEPT ![w] = <<"offer", pc[w][2]>>]
  /\ UNCHANGED <<dsched, holder, faults, scannedOk, pages, shared>>

Finish(w) ==
  /\ pc[w][1] = "finish" /\ LeaseHeldBy(w)
  /\ dsched' = [dsched EXCEPT ![pc[w][2]] = "gone"] /\ holder' = [holder EXCEPT ![pc[w][2]] = 0]
  /\ pc' = [pc EXCEPT ![w] = <<"idle", "x1">>]
  /\ UNCHANGED <<faults, scannedOk, pages, offered, shared>>

-----------------------------------------------------------------------------
(* Faults, the runs, and the Migration. *)

Crash(w) ==
  /\ pc[w][1] # "idle" /\ faults < MaxFaults
  /\ pc' = [pc EXCEPT ![w] = <<"idle", "x1">>] /\ faults' = faults + 1
  /\ UNCHANGED <<dsched, holder, scannedOk, pages, offered, shared>>

SweepLease(a) ==
  /\ dsched[a] = "leased"
  /\ \/ pc[holder[a]][1] = "idle" \/ pc[holder[a]][2] # a
  /\ dsched' = [dsched EXCEPT ![a] = "queued"] /\ holder' = [holder EXCEPT ![a] = 0]
  /\ UNCHANGED <<faults, pc, scannedOk, pages, offered, shared>>

\* R resumes from w1 and parks on X again.
RParksAgain ==
  /\ row["w1"] = "woken" /\ row["w2"] = "none"
  /\ row' = [row EXCEPT !["w2"] = "waiting"]
  /\ match' = [match EXCEPT !["w2"] = match["w1"]]
  /\ UNCHANGED <<dsched, holder, faults, pc, scannedOk, pages, offered, token, arrival,
                 reparked, wakes, wrongWake, missed>>

\* A Migration re-parks q: new token, and the new version's match.
Repark ==
  /\ row["q"] = "waiting" /\ ~reparked
  /\ \E m \in SUBSET Payloads :
       /\ match' = [match EXCEPT !["q"] = m]
  /\ token' = [token EXCEPT !["q"] = @ + 1] /\ reparked' = TRUE
  /\ UNCHANGED <<dsched, holder, faults, pc, scannedOk, pages, offered, row, arrival,
                 wakes, wrongWake, missed>>

Ended ==
  /\ \A a \in ArrivalIds : dsched[a] = "gone"
  /\ \A w \in Workers : pc[w][1] = "idle"
  /\ UNCHANGED vars

WorkerStep(w) ==
  \/ \E a \in ArrivalIds : Claim(w, a)
  \/ Fenced(w) \/ Scan(w) \/ Offer(w) \/ Record(w) \/ Finish(w)

Next ==
  \/ \E w \in Workers : WorkerStep(w) \/ Crash(w)
  \/ \E a \in ArrivalIds : SweepLease(a)
  \/ RParksAgain \/ Repark \/ Ended

Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ \A w \in Workers : WF_vars(WorkerStep(w))
                 /\ \A a \in ArrivalIds : WF_vars(SweepLease(a))

CountersBounded == \A r \in RowSet : wakes[r] <= 2

-----------------------------------------------------------------------------
(* Rules. *)

\* A Wait is woken only by an arrival its match in force accepts.
WakeOnlyOnAMatch == ~wrongWake

\* A Wait is woken at most once, whichever arrival wakes it.
EachWaitWokenOnce == \A r \in RowSet : wakes[r] <= 1

\* One arrival never resumes two Waits of the same run one after the other.
NoSecondWaitFromOneArrival == ~(arrival["w1"] # "none" /\ arrival["w1"] = arrival["w2"])

\* An arrival never passes over a waiting row its match in force accepts and no
\* other arrival has claimed, including one a Migration re-parked since the scan.
NoMatchingParkMissed == ~missed

\* Both deliveries end.
EveryDeliveryEnds == <>(\A a \in ArrivalIds : dsched[a] = "gone")

ReachBothArrivalsWakeSomething == \E r1, r2 \in RowSet : arrival[r1] = "x1" /\ arrival[r2] = "x2"
ReachWokenAfterRepark == reparked /\ row["q"] = "woken"
ReachRefusedByMatch == \A a \in ArrivalIds : dsched[a] = "gone" /\ row["q"] = "waiting" /\ match["q"] = {}
ReachSecondWaitWokenByOtherArrival == arrival["w1"] # "none" /\ arrival["w2"] # "none"
=============================================================================
