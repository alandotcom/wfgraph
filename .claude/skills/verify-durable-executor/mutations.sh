#!/bin/sh
# Shows that each rule can fail. Every mutation removes one guard the design
# depends on, and the rules named beside it must break on the mutated model.
#
#   .claude/skills/verify-durable-executor/mutations.sh
#
# The models are checked unmutated first. A mutation whose rule already breaks
# there proves nothing, so it is reported UNPROVEN and fails the suite, as is a
# MISSED mutation whose rule still holds. Either means the model no longer
# exercises that guard. Exit 0 when every mutation is caught, 1 otherwise.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# model | name | text in the model | replacement | rules that must break
mutations=$(cat <<'MUTATIONS'
DurableExecutor|release-ignores-wait-rows|ReleaseReadsWaitRows == TRUE|ReleaseReadsWaitRows == FALSE|WokenBranchIsNeverStranded SleepingRunHasADeadline EveryRunEnds
DurableExecutor|wake-claims-a-woken-row|WakeIsUnclaimed(p) == park[p] = "open"|WakeIsUnclaimed(p) == park[p] \in {"open", "woken"}|EachWaitWokenOnce
DurableExecutor|branch-run-not-memoized|[] park[p] = "woken"     -> IF StartedSideAdmits THEN "ran"|[] park[p] = "woken"     -> IF StartedSideAdmits THEN "woken"|EachBranchRunsOnce
DurableExecutor|join-admitted-after-one-branch|JoinIsDue == /\ ~joinAdmitted /\ \A p \in Started|JoinIsDue == /\ ~joinAdmitted /\ \E p \in Started|JoinRunsOnceAfterBothBranches
DurableExecutor|outlet-entry-not-memoized|/\ canceledEntered' = TRUE /\ canceledEntries' = canceledEntries + 1|/\ canceledEntered' = canceledEntered /\ canceledEntries' = canceledEntries + 1|CanceledOutletEnteredOnceOnCancel
DurableExecutor|outlet-entered-on-exit|  /\ claim = "cancel" /\ ~canceledEntered|  /\ claim # "none" /\ ~canceledEntered|NoCanceledWorkAfterExit
DurableExecutor|second-claim-overwrites|ClaimIsFree == claim = "none"|ClaimIsFree == TRUE|OneClaimWins
DurableExecutor|no-claim-fence|StartedSideAdmits == claim = "none"|StartedSideAdmits == TRUE|NoStartedWorkAfterAClaim
DurableExecutor|exit-leaves-siblings-parked|[] park[q] = "open"  -> "hwoken"|[] park[q] = "open"  -> "open"|ExitHaltsEveryWait
DurableExecutor|claim-wake-ignored|[] park[p] = "hwoken"    -> "halted"|[] park[p] = "hwoken"    -> "hwoken"|EveryWakeIsActedOn EveryRunEnds
DurableExecutor|no-lease-fencing|LeaseHeldBy(w) == holder = w|LeaseHeldBy(w) == TRUE|OneTerminalRecord
DurableExecutor|policy-cancel-keeps-lease|/\ sched' = "gone" /\ holder' = 0|/\ sched' = "gone" /\ holder' = holder|NothingCommitsAfterTheRunEnds
DurableExecutor|terminal-write-unguarded|RunInFlight == status = "running"|RunInFlight == TRUE|OneTerminalRecord
DurableExecutor|completion-ignores-claim|[] joinDone /\ claim = "none" ->|[] joinDone ->|EndMatchesWork
DurableExecutor|failed-node-ends-the-run|FailedNodeEndsRun == claim = "none"|FailedNodeEndsRun == TRUE|CancelClaimRunsItsOutlet NoWaitLeftOpenAfterTheRunEnds
DurableExecutor|claim-counts-an-attempt|  /\ UNCHANGED <<attempt, faults, dataVars, observers>>|  /\ attempt' = Sat(attempt + 1) /\ UNCHANGED <<faults, dataVars, observers>>|FailedOnlyAfterRetriesSpent
DurableExecutor|expiry-keeps-token|/\ sched' = "queued" /\ holder' = 0 /\ faults' = faults + 1|/\ sched' = "queued" /\ holder' = holder /\ faults' = faults + 1|LeaseHasAHolder
Migration|no-version-fence|StillPinned(w) == pinned = loaded[w]|StillPinned(w) == TRUE|BelowRunsThePinnedVersion
Migration|repin-while-running|RepinNeedsAPark == row = "waiting"|RepinNeedsAPark == TRUE|BelowRunsThePinnedVersion
Migration|migrate-wake-dropped|THEN row' = "migrate" /\ Requeue|THEN UNCHANGED <<row, sched>>|ParkedUnderThePinnedVersion
Migration|repark-keeps-old-version|/\ row' = "waiting" /\ rowVersion' = loaded[w] /\ hopWakes' = 0|/\ row' = "waiting" /\ rowVersion' = rowVersion /\ hopWakes' = 0|ParkedUnderThePinnedVersion
Migration|above-not-memoized|aboveRuns' = IF aboveDone THEN aboveRuns ELSE aboveRuns + 1|aboveRuns' = aboveRuns + 1|AboveRunsOnce
Migration|below-not-memoized|belowRuns' = IF belowDone THEN belowRuns ELSE belowRuns + 1|belowRuns' = belowRuns + 1|BelowRunsOnce
Migration|release-ignores-wait-row|ReleaseReadsWaitRow == TRUE|ReleaseReadsWaitRow == FALSE|WokenWaitIsNeverStranded
Migration|no-lease-fencing|LeaseHeldBy(w) == holder = w|LeaseHeldBy(w) == TRUE|OneTerminalRecord
Migration|expiry-keeps-token|/\ sched' = "queued" /\ holder' = 0 /\ faults' = faults + 1|/\ sched' = "queued" /\ holder' = holder /\ faults' = faults + 1|LeaseHasAHolder
Migration|migrate-wake-never-consumed|THEN /\ row' = "waiting" /\ rowVersion' = loaded[w] /\ hopWakes' = 0|THEN /\ row' = "migrate" /\ rowVersion' = loaded[w] /\ hopWakes' = 0|EveryRunEnds
Migration|fence-refusal-counts-an-attempt|FenceRefusalCountsNoAttempt == TRUE|FenceRefusalCountsNoAttempt == FALSE|FailedOnlyAfterRetriesSpent
Migration|event-wakes-a-delay-park|EventWakeNeedsAnEventPark == rowMode = "event"|EventWakeNeedsAnEventPark == TRUE|EventOnlyWakesAnEventPark
Migration|repark-keeps-old-mode|ReparkMode(w) == mode[loaded[w]]|ReparkMode(w) == rowMode|ParkedInThePinnedMode
Migration|wake-claims-a-woken-row|WakeIsUnclaimed == row = "waiting"|WakeIsUnclaimed == row # "none"|EachHopWokenOnce
Delivery|wake-the-runs-it-settled|ExcludeSettledRuns == TRUE|ExcludeSettledRuns == FALSE|NoWakeInTheRunItStarted NoWakeInARunItSettled
Delivery|scan-and-wake-page-by-page|SavePagesBeforeWaking == TRUE|SavePagesBeforeWaking == FALSE|NoSecondWaitFromOneArrival
Delivery|wake-claims-a-woken-row|WakeIsUnclaimed(r) == row[r] = "waiting"|WakeIsUnclaimed(r) == row[r] \in {"waiting", "woken"}|EachWaitWokenOnce
Delivery|scan-drops-running-runs|/\ run[RunOf[r]] \in {"running", "claimed"}|/\ run[RunOf[r]] = "claimed"|SurvivingWaitsAreWoken
Intake|inbox-key-not-unique|InboxKeyIsUnique == TRUE|InboxKeyIsUnique == FALSE|DuplicateSendIsOneArrival EachArrivalOpensAtMostOneRun
Intake|delivery-id-not-unique|DeliveryIdIsUnique == TRUE|DeliveryIdIsUnique == FALSE|EachArrivalOpensAtMostOneRun
Intake|schedule-row-inserted-later|ExecutionAndScheduleTogether == TRUE|ExecutionAndScheduleTogether == FALSE|EveryOpenRunIsScheduled
Intake|supersede-keeps-schedule|SupersedeDropsSchedule == TRUE|SupersedeDropsSchedule == FALSE|SupersededRunsStop
Intake|first-wins-ignores-live-run|ELSE IF mode = "first" /\ Live # {}|ELSE IF FALSE|OneLiveRunPerEntity
Intake|newest-wins-keeps-old-run|ELSE IF y \in Live /\ mode = "newest" THEN "superseded"|ELSE IF FALSE THEN "superseded"|OneLiveRunPerEntity
Intake|poll-skips-host-rows|/\ inbox[r] = "present" /\ dsched[r] = "none"|/\ inbox[r] = "present" /\ dsched[r] = "none" /\ FALSE|EveryArrivalIsDelivered
Intake|canceled-run-never-ends|  /\ exec[x] = "claimed" /\ esched[x] = "present"|  /\ exec[x] = "claimed" /\ esched[x] = "present" /\ FALSE|EveryRunEnds
Intake|refusal-not-consulted|RefusalIsConsulted == TRUE|RefusalIsConsulted == FALSE|AdmissionDecidedOnce
Intake|concurrency-before-eligibility|EligibilityBeforeConcurrency == TRUE|EligibilityBeforeConcurrency == FALSE|RefusedArrivalChangesNothing
Arrivals|claim-ignores-the-token|ClaimNeedsTheToken == TRUE|ClaimNeedsTheToken == FALSE|WakeOnlyOnAMatch
Arrivals|no-refresh-after-a-repark|RefreshOnRotatedToken == TRUE|RefreshOnRotatedToken == FALSE|NoMatchingParkMissed
Arrivals|claim-takes-a-woken-row|RowIsWaiting(r) == row[r] = "waiting"|RowIsWaiting(r) == row[r] # "none"|EachWaitWokenOnce
Arrivals|rescan-on-retry|IF scannedOk[a] THEN|IF FALSE THEN|NoSecondWaitFromOneArrival
Arrivals|offer-never-recorded|offered' = [offered EXCEPT ![pc[w][2]] = @ + 1]|offered' = offered|EveryDeliveryEnds
Handler|no-idempotency-key|SendCarriesAKey == TRUE|SendCarriesAKey == FALSE|WriteAppliedOnce
Handler|read-not-memoized|ReadIsMemoized == TRUE|ReadIsMemoized == FALSE|AppliedWriteMatchesTheOutput
Handler|refusal-thrown|RefusalIsAValue == TRUE|RefusalIsAValue == FALSE|RefusalFailsTheNodeOnce
Handler|no-retries|/\ attempt + 1 >= MaxAttempts ->|/\ attempt + 1 >= 1 ->|FailedOnlyOnRefusalOrSpentRetries
Handler|success-never-ends-the-node|CASE memoSend = "ok" ->|CASE FALSE ->|NodeEnds
Timing|heartbeat-slower-than-lease|NodeHeartbeat == 1|NodeHeartbeat == 3|LiveLeaseNeverExpires
Timing|no-cron-sweep|WorkerUsesCron == TRUE|WorkerUsesCron == FALSE|DeadlineHonouredOnTime EveryRunEndsInTime
Timing|claim-ignores-the-deadline|ClaimWaitsForTheDeadline == TRUE|ClaimWaitsForTheDeadline == FALSE|NoResumeBeforeTheDeadline
Timing|budget-shorter-than-a-step|WorkerBudget == 6|WorkerBudget == 3|EveryRunEndsInTime
Timing|sweep-runs-late|SweepLateness == 0|SweepLateness == 3|DeadWorkerRecoveredInTime
MUTATIONS
)

# Rules that break on the models as written, as "Model:Rule". Each is a
# finding SKILL.md records, and this list must match what check.sh reports.
findings=""

echo "checking the models as written"
base=$("$here/check.sh" 2>&1) || true
if printf '%s\n' "$base" | grep -q '^error'; then
  printf '%s\n' "$base" | grep -A5 '^error'; exit 2
fi

failed=0
while IFS='|' read -r model name from to rules; do
  for rule in $rules; do
    if printf '%s\n' "$base" | grep -q "^breaks  $model $rule\$"; then
      echo "UNPROVEN $model $name: $rule already breaks on the model as written"; failed=1; continue 2
    fi
  done
  rm -rf "$work/models" && cp -R "$here/model" "$work/models"
  matches=$(FROM=$from perl -0ne 'my $n = () = /\Q$ENV{FROM}\E/g; print $n' "$work/models/$model.tla")
  if [ "$matches" -eq 0 ]; then
    echo "missing  $model $name: the model no longer contains: $from"; failed=1; continue
  elif [ "$matches" -gt 1 ]; then
    echo "AMBIGUOUS $model $name: the model contains this text $matches times: $from"; failed=1; continue
  fi
  FROM=$from TO=$to perl -0pi -e 's/\Q$ENV{FROM}\E/$ENV{TO}/' "$work/models/$model.tla"
  result=$(MODEL_DIR=$work/models RULES=$rules "$here/check.sh" "$model" 2>&1) || true
  if printf '%s\n' "$result" | grep -q '^error'; then
    echo "ERROR    $model $name: tla-ts could not check the mutated model"
    printf '%s\n' "$result" | grep -A5 '^error'; failed=1; continue
  fi
  for rule in $rules; do
    if printf '%s\n' "$result" | grep -q "^breaks  $model $rule\$"; then
      echo "caught   $model $name breaks $rule"
    else
      echo "MISSED   $model $name: $rule still holds"; failed=1
    fi
  done
done <<EOF
$mutations
EOF

# Every rule is either proven able to fail by a mutation or is a known finding.
covered=$(printf '%s\n' "$mutations" | awk -F'|' '{ n = split($5, r, " "); for (i = 1; i <= n; i++) print $1 ":" r[i] }')
for cfg in "$here"/model/*.cfg; do
  model=$(basename "$cfg" .cfg)
  for rule in $(sed -n 's/^INVARIANT //p; s/^PROPERTY //p' "$cfg"); do
    key="$model:$rule"
    if printf ' %s ' "$findings" | grep -q " $key "; then
      if printf '%s\n' "$base" | grep -q "^breaks  $model $rule\$"; then
        echo "finding  $model $rule breaks on the model as written"
      else
        echo "STALE    $model $rule no longer breaks: remove it from the findings and add a mutation"; failed=1
      fi
    elif ! printf '%s\n' "$covered" | grep -qx "$key"; then
      echo "UNCOVERED $model $rule: no mutation shows it can fail"; failed=1
    fi
  done
done
printf '%s\n' "$base" | sed -n 's/^breaks  \([^ ]*\) \([^ ]*\)$/\1:\2/p' | while read -r key; do
  printf ' %s ' "$findings" | grep -q " $key " || echo "NEW      $key breaks on the model as written and is not a recorded finding"
done
printf '%s\n' "$base" | sed -n 's/^breaks  \([^ ]*\) \([^ ]*\)$/\1:\2/p' | while read -r key; do
  printf ' %s ' "$findings" | grep -q " $key " || exit 1
done || failed=1
exit $failed
