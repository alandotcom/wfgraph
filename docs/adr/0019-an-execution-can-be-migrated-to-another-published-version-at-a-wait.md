# 19. An Execution can be migrated to another published version at a Wait

Date: 2026-09-09

## Status

Accepted. This decision amends ADR-0015: the two engine changes it required
crossed the durable-protocol boundary that ADR names.

## Context

ADR-0012 pins each Execution to the Workflow Version it started against, and
readers resolve node ids against that pinned graph. A published edit therefore
reached new runs only. A run that had already parked on a Wait ran the old
version's definitions when it woke, however long it had left to wait.

ADR-0011 made each waiting branch a durable run of its own, so a parked branch
is addressable while it waits. The park itself was `step.sleep`. Inngest decides
when a sleeping invocation resumes, so nothing outside the run could reach it,
and a schedule change could not shorten or lengthen a park already registered.

The case that made this worth doing is a workflow with long delay Waits, such
as a campaign that parks each run for days between sends. The Workflow Builder
corrects a step below the Wait, and the correction reaches nothing already in
flight.

## Decision

Two engine changes came first. A delay-mode Wait parks on `waitForEvent` with
the remaining delay as its timeout, so a signal can reach it. Both Wait modes
carry an attempt index in their step ids, so a second park is a fresh memoized
step rather than a replay of the first.

A `version-migrate` wait signal makes a parked Wait recompute its parameters
from the config the body loaded on wake. The body reads that config from the
graph of the version the execution row pins, so moving the pointer changes what
the recompute reads. The first park records the instant it resolved against, and
every recompute resolves durations, targets and allowed hours from that instant.
A Migration therefore shortens or lengthens the remaining wait and leaves the
clock running from the first park.
A recomputed target already in the past resumes without parking. The Wait's
output gains a `hops` field counting actual parks.

A Migration is its own action, taken after Publish rather than as part of
Publish. Migrating is rare, and moving an in-flight run is worth reading about
before it happens. `previewMigration` produces that preflight report, and
`migrateExecutions` performs the move for the runs the caller names.

The preflight classifies every in-flight run not already on the target version
as eligible or refused. The refusal reasons are `draft_run`, `executing`,
`wait_node_missing`, `unresolved_reference` and `wait_timeout_elapsed`, and
`packages/shared/src/graph/migration-contracts.ts` states what each one means.
`unresolved_reference` is the reason the preflight exists: a template below a
parked Wait in the target version can address a node the run produced no output
for, and moving that run would move it into a failure.

`migrateExecutions` re-checks the runs it was handed, moves each eligible run's
version pointer under a guard on the run's status and current version, records
the run-scoped audit event `run_migrated`, and sends one `version-migrate`
signal per parked row.

A Migration never re-runs a node above the Wait. Node outputs are memoized and
nothing above a Wait re-runs, so the run keeps every output it already produced
and picks up the new version's definitions from the Wait downward.

## Consequences

A new version may change what happens below a parked Wait, including the Wait's
own delay, target time and allowed hours. It cannot change what a migrated run
already did. A node the old version ran keeps its stored output even when the
target version defines that node differently or removes it.

`unresolved_reference` is the check that keeps the second property honest. A
template in the target version can address a node the old version never had, and
the run has no output to resolve it against, so the preflight refuses the run
instead of migrating it into a failure.

A partial Migration is normal. Refused runs stay on their old version, so one
workflow's in-flight population is spread over two versions, and each run's
version label in the run list is what says which version it is on.

A delay Wait carries no resume token, because a delay park cannot honour a
wait-resume signal. Execution id and node id address such a park on their own,
which is what `migrateExecutions` sends against.

The service cannot close two windows on its own. A Migration signalled while an
attempt is between reading the pinned version and parking again lands under the
graph that attempt already loaded, and a second Migration inside the same round
trip does the same. The engine's version check on every attempt is what turns
both into a retry: the prepare and resume steps compare the execution row's
pinned version with the version the body loaded, and a mismatch fails in a way
Inngest retries, so the next attempt loads the newer graph.

Each hop costs its own prepare, park and resume steps. A run migrated many times
grows its step count in proportion to its hops, against Inngest's limit of 1000
steps per function run. Nothing bounds the number of Migrations a run can
receive, so a workflow whose runs are migrated dozens of times is the shape to
watch.
