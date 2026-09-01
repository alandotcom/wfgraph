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
