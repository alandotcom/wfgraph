# 15. Engine epochs are deferred until an incompatible protocol change

Date: 2026-09-01

## Status

Accepted.

## Context

Workflow versions pin an immutable graph and the extension catalog fingerprint
that graph was checked against (ADR-0012). They do not pin Workflow Graph's
engine implementation. A parked Inngest run resumes in the currently deployed
handler and reuses durable state by function, event, and step identity.

That behavior is safe while engine changes remain compatible with those
identities and their persisted values. An incompatible change could strand a
parked run, route a signal to the wrong function generation, or decode memoized
state under a new shape. The catalog fingerprint cannot detect that class of
change, and an engine epoch would not preserve a host action implementation or
make a changed catalog compatible.

No incompatible engine change was pending. Persisting an epoch with one value,
registering duplicate functions, and routing every send through a registry would
therefore add migration and deployment machinery with no second implementation
to select.

## Decision

The current durable protocol remained the compatibility boundary. Changes were
required to preserve these identities and value shapes while an in-flight
Execution could still reference them:

- The `workflow-run` and `workflow-branch` function ids, and listener ids made by
  `toListenerFunctionId`.
- The `workflow/run.requested`, `workflow/run.cancel.requested`,
  `workflow/branch.kill.requested`, and `workflow/wait.signal` event names,
  including their cancellation expressions and idempotency keys.
- The run request, branch invocation, cancellation, branch-kill, and wait-signal
  payload schemas. These schemas use `rejectUnknownKeys`, so adding a key is not
  compatible during a mixed deployment.
- Durable step ids, including `run-metadata`, `node:<nodeId>:<stepId>`, node log
  ids, Wait ids, lifecycle-check ids, branch ids, `branch-kill-sweep`,
  `workflow-run-completed`, and `workflow-run-failed`.
- Memoized action results, JSON-safe node outputs, the `_inngest` invocation
  metadata, branch results, and wait metadata read after resumption.

An incompatible change was required to introduce the engine-epoch mechanism
with the new protocol, not before it. That change would stamp an epoch on
published versions and draft snapshots, register epoch-specific parent and
branch functions, and route run, wait, cancellation, and branch traffic from
the pinned version's epoch. The old function set would remain registered until
Version Usage reported no in-flight run on that epoch.

Existing executions were not to be rewritten to a newer workflow version or
epoch. Compatible current code could resume them; exact deployment artifacts
were not pinned.

## Consequences

Version Usage provided the operational evidence needed before a future epoch
was retired. It reported the current version and every version pinned by an
in-flight run, together with action availability and catalog drift.

Engine changes required an explicit compatibility review against this list. The
first incompatible change would bear the cost of epoch persistence, migrations,
registration, routing, and cross-epoch live verification.

A rolling deploy could answer Version Usage from a process whose catalog
differed from the process that later resumed a run. Catalog status therefore
described the server answering the request, not every process in the deployment.

Assigning an epoch immediately was rejected because one persisted value and one
routing branch carried no compatibility choice. Assigning a new Inngest
function id on every deploy was rejected because routine deploys would strand
parked runs without adding semantic safety.

## Amendment (2026-09-09)

ADR-0019 made the first incompatible change to the durable protocol this ADR
named as the compatibility boundary. Wait step ids gained an attempt index, a
delay park moved from `step.sleep` to `step.waitForEvent`, and the wait-signal
payload schema gained a literal, which `rejectUnknownKeys` treats as
incompatible during a mixed deployment. This ADR's statement that existing
executions were not to be rewritten to a newer workflow version no longer holds:
a Migration moves an open Execution's pinned version at a parked Wait.

The project accepted the break under the no-backwards-compatibility convention
in AGENTS.md, because no external consumer holds parked runs. The engine-epoch
mechanism remains deferred; nothing in ADR-0019 stamps or routes an epoch.

An adopter running a version before ADR-0019 drains its parked runs before
upgrading. A run parked under the old Wait step ids resumes into a handler that
has none of them.

## Amendment (2026-11-05)

ADR-0021 moved workflow runs off Inngest onto an executor in the application database,
which is the second incompatible change to the durable protocol this ADR named. The
function ids that ran workflows, the run, cancellation, branch-kill and wait-signal events,
their payload schemas, the branch ids and results, and the Inngest invocation metadata no
longer exist. The project accepted the break under the no-backwards-compatibility
convention in AGENTS.md, as it accepted ADR-0019's, and the engine-epoch mechanism remains
deferred. An adopter drains its in-flight runs before upgrading, because a run that Inngest
held has no schedule row for the executor to claim.

The compatibility boundary is now smaller and lives in the adopter's database. It is the
durable step ids, including `workflow-run-completed`, `workflow-run-failed`, the
`lifecycle-check` ids, node log ids and Wait ids; the JSON values the step memo holds in
`workflow_execution_steps`; the wake a producer writes onto a wait row; and, for Event
delivery alone until the event inbox, the listener ids that `toListenerFunctionId` makes.
During a rolling deploy, worker loops from both builds claim passes of the same run, so a
change to one of those ids or value shapes is incompatible during the deploy in the way a
payload schema change was.

The epoch mechanism this ADR described routed run, wait, cancellation and branch traffic
to epoch-specific Inngest functions. That traffic is now rows the executor reads, so a
future epoch would be a stamp a pass reads to choose the engine that replays the run. The
terminal write deletes a run's memo rows, so only in-flight runs hold memoized state, and
Version Usage's report of in-flight runs remains the evidence for retiring an epoch.

## Amendment (2026-11-05, event inbox)

ADR-0022 moved Event delivery onto the same executor, so the listener ids that
`toListenerFunctionId` made are no longer part of the boundary. The Inngest functions that
remain record an `inngest.send` in the inbox in one step and hold no delivery state, so a
forwarder invocation that spans a deploy only records its Event once more under the same
idempotency key.

The boundary gains the delivery body's durable step ids (`subscribers-*`, `lifecycle-*`,
`wait-candidates-*` and `waits-*`) and the values their memo rows hold, and the inbox id as
the `deliveryId` a run and a wake carry. These are compatible during a rolling deploy only if
both builds read them alike, as the run's step ids are. A delivery's memo is deleted when the
delivery settles, so only a pending delivery holds memoized state, and a delivery pins no
workflow version: it reads the published versions as they stand when it runs. A future epoch
therefore has no version to stamp a delivery from. An incompatible change to the delivery
body drains pending deliveries before the deploy instead, which takes seconds, where a run
can stay parked for months.

The inbox table itself is a contract a host's own SQL insert depends on, which no epoch
covers. A change to it is a breaking change for adopters, released as one. The engine-epoch
mechanism remains deferred.
