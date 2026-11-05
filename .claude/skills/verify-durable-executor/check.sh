#!/bin/sh
# Checks the durable executor models with tla-ts, one rule per run so a rule
# that breaks never hides another.
#
#   .claude/skills/verify-durable-executor/check.sh             every model
#   .claude/skills/verify-durable-executor/check.sh Migration   one model
#   MODEL_DIR=/path/to/copy .claude/skills/verify-durable-executor/check.sh
#   RULES="EveryRunEnds OneTerminalRecord" .../check.sh DurableExecutor
#
# RULES limits the run to the named invariants and properties and skips the
# deadlock and reachability checks; mutations.sh uses it.
#
# Each model is model/<Name>.tla with model/<Name>.cfg. In the config, an
# INVARIANT is checked under Spec, a PROPERTY under FairSpec, and a comment line
# `\* REACH <Predicate>` names a state that must be reachable, which shows the
# model is not passing by checking nothing.
#
# Output, one line per check: `holds`, `breaks` or `unreached`, the model, the
# rule. A rule that breaks is followed by its shortest path as action names.
# Exit 0 when everything holds and is reached, 1 otherwise, 2 when tla-ts
# cannot check a model.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
models_dir=${MODEL_DIR:-$here/model}
tla_ts="pnpm --silent dlx tla-ts@0.0.8"
workers="-workers auto"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$models_dir"/*.tla "$work"/

if [ $# -gt 0 ]; then models=$*; else
  models=$(cd "$models_dir" && ls *.cfg | sed 's/\.cfg$//')
fi

status=0
path_of() { printf '%s\n' "$1" | sed -n 's/^State \([0-9]*\): <\([^ >]*\).*/        \1. \2/p; s/^State \([0-9]*\): Stuttering/        \1. (stays here forever)/p; s/^State \([0-9]*\): Back to state \([0-9]*\).*/        \1. (back to step \2, forever)/p'; }

# check MODEL NAME KIND OPERATOR SPEC [tla-ts flags]
check() {
  model=$1; name=$2; kind=$3; op=$4; spec=$5; shift 5
  grep -v -e '^INVARIANT' -e '^PROPERTY' -e '^SPECIFICATION' "$models_dir/$model.cfg" > "$work/$name.cfg"
  printf 'SPECIFICATION %s\n%s %s\n' "$spec" "$kind" "$op" >> "$work/$name.cfg"
  out=$(cd "$work" && $tla_ts "Check$model.tla" -config "$name.cfg" $workers "$@" 2>&1 || true)
}

for model in $models; do
  [ -f "$models_dir/$model.cfg" ] || { echo "no model named $model"; exit 2; }
  {
    echo "---- MODULE Check$model ----"
    echo "EXTENDS $model"
    sed -n 's/^\\\* REACH \([A-Za-z0-9_]*\).*/Not\1 == ~\1/p' "$models_dir/$model.cfg"
    echo "===="
  } > "$work/Check$model.tla"

  selected() { [ -z "${RULES:-}" ] || printf ' %s ' "$RULES" | grep -q " $1 "; }

  if [ -z "${RULES:-}" ]; then
  # Deadlock: every state other than an ended run has a step out.
  grep -v -e '^INVARIANT' -e '^PROPERTY' "$models_dir/$model.cfg" > "$work/deadlock.cfg"
  out=$(cd "$work" && $tla_ts "Check$model.tla" -config deadlock.cfg $workers 2>&1 || true)
  if printf '%s\n' "$out" | grep -q 'No error has been found'; then
    printf '%s\n' "$out" | sed -n "s/^[0-9]* states generated, \([0-9]*\) distinct states found.*/model   $model: \1 distinct states/p"
    echo "holds   $model NoDeadlock"
  elif printf '%s\n' "$out" | grep -q 'Deadlock reached'; then
    echo "breaks  $model NoDeadlock"; path_of "$out"; status=1
  else
    echo "error   $model NoDeadlock"; printf '%s\n' "$out" | grep -i 'error' | head -5; exit 2
  fi
  fi

  for rule in $(sed -n 's/^INVARIANT //p' "$models_dir/$model.cfg"); do
    selected "$rule" || continue
    check "$model" "$rule" INVARIANT "$rule" Spec -deadlock
    if printf '%s\n' "$out" | grep -q 'No error has been found'; then
      echo "holds   $model $rule"
    elif printf '%s\n' "$out" | grep -q "Invariant $rule is violated"; then
      echo "breaks  $model $rule"; path_of "$out"; status=1
    else
      echo "error   $model $rule"; printf '%s\n' "$out" | grep -i 'error' | head -5; exit 2
    fi
  done

  for rule in $(sed -n 's/^PROPERTY //p' "$models_dir/$model.cfg"); do
    selected "$rule" || continue
    check "$model" "$rule" PROPERTY "$rule" FairSpec -deadlock
    if printf '%s\n' "$out" | grep -q 'No error has been found'; then
      echo "holds   $model $rule"
    elif printf '%s\n' "$out" | grep -q "Temporal property $rule was violated\|Temporal properties were violated"; then
      echo "breaks  $model $rule"; path_of "$out"; status=1
    else
      echo "error   $model $rule"; printf '%s\n' "$out" | grep -i 'error' | head -5; exit 2
    fi
  done

  [ -z "${RULES:-}" ] || continue
  for reach in $(sed -n 's/^\\\* REACH \([A-Za-z0-9_]*\).*/\1/p' "$models_dir/$model.cfg"); do
    check "$model" "$reach" INVARIANT "Not$reach" Spec -deadlock
    if printf '%s\n' "$out" | grep -q "Invariant Not$reach is violated"; then
      echo "reached $model $reach"
    elif printf '%s\n' "$out" | grep -q 'No error has been found'; then
      echo "unreached $model $reach"; status=1
    else
      echo "error   $model $reach"; printf '%s\n' "$out" | grep -i 'error' | head -5; exit 2
    fi
  done
done
exit $status
