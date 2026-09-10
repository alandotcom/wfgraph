# 20. Host-resolved Entity Eligibility controls Execution admission

Date: 2026-09-10

## Status

Accepted. This decision extends ADR-0007's Lifecycle Rules, ADR-0008's assembled
catalog, ADR-0011's branch coordination, ADR-0012's version pinning, ADR-0016's
admission model, and ADR-0019's Migration preflight.

## Context

A Workflow Builder could keep a run from acting on stale domain state only by
placing a lookup and Condition in the graph. Outputs above a Wait are durably
memoized, so a workflow that needed current state had to repeat that pair after
every Wait. Omitting one copy could send a message or change an external system
after the host no longer considered the subject eligible.

Moving that state into Workflow Graph would create a second system of record.
Using an Event payload alone would answer what was true when the Event was sent,
not what is true when a parked run resumes. A generic lookup action would expose
the state to templates and outputs and would still leave the builder responsible
for putting the check at every boundary.

The lifecycle already distinguishes admission from routing. A Start Filter
rejects an Event payload before Concurrency and before an Execution exists
(ADR-0016). A Condition node routes a run that already exists. Cancel Events
interrupt an active run through the Canceled outlet (ADR-0007). Current host state
needs the same explicit distinction: rejection before admission and a terminal
business outcome after admission.

## Decision

The host defines an Entity with `defineEntity`. An Entity definition has a stable
`type`, a human label, a schema for current state, and a read-only resolver from
`entityId` to current state or `null`. The host remains the system of record.
Workflow Graph validates and JSON-encodes a resolver result only long enough to
make an Eligibility decision. It never persists Entity State or puts it in step
inputs, outputs, templates, logs, audit metadata, or durable decisions.

An Event refers to Entity definitions through named bindings. Each binding has a
synchronous `selectEntityId` function typed from the Event's validated schema.
The workflow payload remains the original JSON; only the selector sees the
decoded representation. Definitions are discovered transitively from the Events
passed to `extensions.events`, preserving ADR-0008's one assembled surface and
avoiding a second registration list or import side effects.

The Lifecycle Rules may select one tracked Entity type and one binding for every
Start and Cancel Event. Those bindings become the sole source of typed Entity
identity for guarded workflows. Every guarded Execution persists the immutable
pair `{ entityType, entityId }`; Correlation Paths and the legacy untyped Entity
Value remain for unguarded workflows.

Entity Eligibility is one positive condition over the selected Entity's current
state. It has two independent checkpoints, and at least one must be selected:

- **Before opening an Execution** runs after Event validation and the payload
  Start Filter, then before Concurrency and any Execution write. A false condition
  or missing Entity records a Refused Start and opens no Execution.
- **Before each workflow node** runs immediately before each enabled executable
  node reachable from Started, including Conditions, Event Splits, and Waits. It
  excludes the Lifecycle Node, visual Groups, placeholders, disabled nodes, and
  every node on the Canceled side. A false condition or missing Entity claims the
  execution-wide terminal outcome `exited` before the node begins.

Resolver rejection, timeout, or schema-invalid state is an operational failure.
It retries Event delivery before admission and follows normal Execution failure
handling after admission. A `null` result is the expected `entity_not_found`
business outcome. A false condition is `entity_condition_not_met`.

Each in-run check is one durable decision identified by the pinned Workflow
Version, condition digest, durable invocation, and target node. Replay reuses that
verdict; a later node resolves fresh state. Sibling nodes do not share a state
snapshot and may observe different host states.

Exit, cancellation, supersession, completion, and failure share one atomic
first-durable-claim-wins boundary. After a Cancel or Exit claim, no new node may
be admitted. Work already admitted may finish because Workflow Graph cannot
revoke an external side effect already dispatched. Exit has no graph outlet and
does not make the durable function appear failed.

A branch that wins an Exit claim reports it to the parent and survives long
enough to do so. The parent remains the single owner of terminalization and
open-work cleanup, stops sibling durable branches, and records one `exited`
terminal status. Losing claimants observe the authoritative stored outcome and
do not stop the winning reporter.

Audit data records only the reason code, Entity type, condition identifier,
checkpoint, blocked node when one exists, and check time. Entity IDs are retained
only as immutable Execution identity and supplied to the resolver; they stay out
of audit metadata, logs, and durable decision values. Resolved state never leaves
the resolver adapter.

A guarded manual or Draft run must name a Start Event and provide a payload that
its selected binding accepts. A node-only guard establishes and persists typed
identity without resolving state at admission. A paused guarded run also
establishes identity without invoking the resolver. Entity-less scheduled starts
are refused.

Migration preserves the Execution's typed Entity identity. Preflight refuses a
target version that tracks another Entity type or whose Eligibility condition no
longer fits the live Entity schema. Graph behavior remains version-pinned under
ADR-0012, while a resolver implementation change that keeps the same Entity type
and schema deliberately reaches the next new checkpoint of an in-flight run.
Earlier durable verdicts remain fixed.

## Considered Options

- **Persist a copy of host state** rejected: it creates ownership, retention, and
  privacy obligations for data Workflow Graph needs only for a point-in-time
  decision.
- **Expose the resolver as a lookup action** rejected: the state would enter
  workflow outputs and every builder would still have to place and maintain the
  check after each Wait.
- **Use Correlation Paths for typed identity** rejected: a free-form path cannot
  prove that Events refer to one Entity type, cannot share a state schema, and
  gives payload refactors no TypeScript feedback.
- **Register Entities in `extensions.entities`** rejected: Event object references
  already form the dependency graph, and a second list can drift from it.
- **Reuse an admission verdict at the first node** rejected: admission and node
  checkpoints answer different point-in-time questions. Selecting both means two
  reads when the first node starts.
- **Continuously poll while a Wait is parked** rejected: it adds an unbounded
  scheduler and resolver load. A host needing immediate interruption sends a
  Cancel Event.
- **Route Exit through Canceled** rejected: cancellation is a host Event with an
  explicit cleanup branch; ineligibility is a business stop with no such signal.
- **Kill work already admitted** rejected: Workflow Graph cannot safely undo an
  arbitrary external side effect. The enforceable guarantee is that no successor
  is admitted after the claim.

## Consequences

The editor presents payload Start Filters and Entity Eligibility separately and
states the checkpoint order. Publish refuses missing or mixed bindings, malformed
or schema-incompatible conditions, Correlation Path overrides on guarded Events,
unsupported start sources, and an empty checkpoint set.

Resolver reads occur on the Event-delivery hot path when admission checking is
enabled and before each new Started-side node when node checking is enabled. Wide
fan-out can produce concurrent resolver reads. Hosts must make resolvers read-only
and safe for that load.

Run history gains `exited` beside completed, canceled, superseded, and failed.
The detail view identifies the condition and node boundary from structured audit
metadata without matching message text or revealing the Entity instance.

The catalog fingerprint includes Entity type, binding metadata, state fields, and
a state-schema digest. Resolver function identity is intentionally absent, as
handler bodies are absent for actions. A schema change therefore requires publish
compatibility work, while a resolver logic fix can govern new checkpoints
immediately.

## Amendment: Tracking without Eligibility

Date: 2026-09-10

A Lifecycle may select a tracked Entity and its Event bindings without declaring
Entity Eligibility. The tracked identity still governs Concurrency and Cancel
Events. Resolver reads occur only when the Lifecycle also declares Eligibility.
This separates the stable identity needed to match runs from the optional
current-state rule that admits or exits them.

The host may set `entityResolverTimeoutMs` on `createWfGraphApp` or `wfWorker`.
The default remains 10,000 milliseconds. The app validates the value at startup and applies
one deadline to every admission and node-checkpoint resolver call.
