#!/bin/sh
# Checks the Design A executor model rule by rule with tla-ts, so a rule that
# breaks never hides another. Prints one line per rule and, for a rule that
# breaks, the shortest path to it as the model's action names.
#
#   .claude/skills/verify-durable-executor/check.sh
#   SPEC=/path/to/Mutated.tla .claude/skills/verify-durable-executor/check.sh
#
# Exit 0 when every rule holds, 1 when a rule breaks, 2 when tla-ts errors.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
spec=${SPEC:-$here/model/DurableExecutor.tla}
cfg=$here/model/DurableExecutor.cfg
tla_ts="pnpm --silent dlx tla-ts@0.0.8"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$spec" "$work/DurableExecutor.tla"
grep -v '^INVARIANT' "$cfg" > "$work/base.cfg"


status=0
# Deadlock: every state other than an ended run has a step out.
out=$(cd "$work" && $tla_ts DurableExecutor.tla -config base.cfg 2>&1 || true)
if printf '%s\n' "$out" | grep -q 'No error has been found'; then
  printf '%s\n' "$out" | sed -n 's/^\([0-9]* states generated, [0-9]* distinct states found\).*/model: \1/p'
  echo "holds   NoDeadlock"
elif printf '%s\n' "$out" | grep -q 'Deadlock reached'; then
  echo "breaks  NoDeadlock"; printf '%s\n' "$out" | sed -n 's/^State \([0-9]*\): <\([^ ]*\) .*/        \1. \2/p'
  status=1
else
  echo "error   NoDeadlock"; printf '%s\n' "$out" | grep -i 'error' | head -5
  exit 2
fi

for rule in $(sed -n 's/^INVARIANT //p' "$cfg"); do
  { cat "$work/base.cfg"; echo "INVARIANT $rule"; } > "$work/$rule.cfg"
  out=$(cd "$work" && $tla_ts DurableExecutor.tla -config "$rule.cfg" -deadlock 2>&1 || true)
  if printf '%s\n' "$out" | grep -q 'No error has been found'; then
    echo "holds   $rule"
  elif printf '%s\n' "$out" | grep -q "Invariant $rule is violated"; then
    echo "breaks  $rule"
    printf '%s\n' "$out" | sed -n 's/^State \([0-9]*\): <\([^ ]*\) .*/        \1. \2/p'
    status=1
  else
    echo "error   $rule"; printf '%s\n' "$out" | grep -i 'error' | head -5
    exit 2
  fi
done
exit $status
