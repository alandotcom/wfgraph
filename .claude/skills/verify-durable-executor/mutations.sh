#!/bin/sh
# Shows that each rule can fail. Every mutation removes one guard the design
# depends on, and the rule beside it must break on the mutated model. A
# mutation whose rule still holds means the model no longer exercises that
# guard, which is a modelling error to fix before trusting a pass.
#
#   .claude/skills/verify-durable-executor/mutations.sh
#
# Exit 0 when every mutation is caught, 1 otherwise.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
spec=$here/model/DurableExecutor.tla
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# name | text in the model | replacement | rules that must break, space-separated.
# FailedOnlyAfterRetriesSpent has no mutation: it breaks on the model as
# written, which is the finding SKILL.md records.
mutations=$(cat <<'MUTATIONS'
release-ignores-wait-rows|ReleaseReadsWaitRows == TRUE|ReleaseReadsWaitRows == FALSE|WokenBranchIsNeverStranded SleepingRunHasADeadline
wake-claims-a-woken-row|WakeIsUnclaimed(p) == park[p] = "open"|WakeIsUnclaimed(p) == park[p] \in {"open", "woken"}|EachWaitWokenOnce
branch-run-not-memoized|[] park[p] = "woken"     -> IF StartedSideAdmits THEN "ran"|[] park[p] = "woken"     -> IF StartedSideAdmits THEN "woken"|EachBranchRunsOnce
join-admitted-after-one-branch|ELSE IF \A p \in Parks : park[p] = "ran"|ELSE IF \E p \in Parks : park[p] = "ran"|JoinRunsOnceAfterBothBranches
outlet-not-memoized|THEN /\ outletDone' = TRUE /\ outletRuns' = outletRuns + 1|THEN /\ outletDone' = outletDone /\ outletRuns' = outletRuns + 1|OutletRunsOnceOnCancelClaim
no-claim-fence|StartedSideAdmits == claim = "none"|StartedSideAdmits == TRUE|NoStartedWorkAdmittedAfterClaim
no-lease-fencing|LeaseHeldBy(w) == holder = w|LeaseHeldBy(w) == TRUE|OneTerminalRecord
policy-cancel-keeps-lease|/\ sched' = "gone" /\ holder' = 0|/\ sched' = "gone" /\ holder' = holder|NothingCommitsAfterTheRunEnds
terminal-write-unguarded|RunInFlight == status = "running"|RunInFlight == TRUE|OneTerminalRecord
completion-ignores-claim|outletDone \/ (joinDone /\ claim = "cancel") ->|outletDone ->|EndMatchesWork
expiry-keeps-token|/\ sched' = "queued" /\ holder' = 0|/\ sched' = "queued" /\ holder' = holder|LeaseHasAHolder
MUTATIONS
)

printf '%s\n' "$mutations" | while IFS='|' read -r name from to rule; do
  FROM=$from TO=$to perl -0pe 's/\Q$ENV{FROM}\E/$ENV{TO}/ or die "mutation text not found\n"' "$spec" > "$work/DurableExecutor.tla" \
    || { echo "missing $name: the model no longer contains: $from"; exit 1; }
  result=$(SPEC=$work/DurableExecutor.tla "$here/check.sh" 2>&1) || true
  if printf '%s\n' "$result" | grep -q '^error'; then
    echo "ERROR   $name: tla-ts could not check the mutated model"; printf '%s\n' "$result" | grep -A5 '^error'; exit 1
  fi
  for one in $rule; do
    if printf '%s\n' "$result" | grep -q "^breaks  $one\$"; then
      echo "caught  $name breaks $one"
    else
      echo "MISSED  $name: $one still holds"; exit 1
    fi
  done
done
