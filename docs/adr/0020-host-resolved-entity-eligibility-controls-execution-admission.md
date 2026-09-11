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

Each in-run check is one durable decision identified by the target node within
its durable invocation. Replay reuses that verdict; a later node resolves fresh
state. Sibling nodes do not share a state
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

## Amendment: Exit leaves parked sibling branches parked

Date: 2026-09-10

The parent run no longer stops sibling durable branches after an Exit claim.
Stopping them selectively needed a `cancelOn` expression on `workflow-branch`
that spared the branch reporting the Exit and its parents. Inngest validates
every `cancelOn` expression at registration against a restrictive CEL policy
that refuses every macro and every function outside comparison, logic, indexing
and type conversion, so that expression prevented the branch function from
registering at all.

After an Exit claim, a sibling branch run parked on a Wait stays parked until
that Wait ends. It then asks the store to admit its next node, the Exit claim
refuses it, and the branch returns to the parent with its own rows closed. The
parent still records the one `exited` terminal status. `workflow/branch.kill.requested`
now ends every branch run of an Execution and is sent only for a Cancel Event.

## Amendment: The Exit winner wakes parked sibling Waits

Date: 2026-09-10

After an Exit claim, the run that won the claim, whether the parent or a branch,
read the Execution's parked Waits and sent each a `workflow/wait.signal` with
signal type `lifecycle-exit`. Inngest's CEL policy accepted the Wait's match
expression, because the signal selected a Wait by execution id and node id with
equality comparisons alone. A woken Wait closed its row as cancelled, halted its
branch, and returned through `step.invoke`; the parent then recorded `exited`
from the claim. The Waits of the winning run and of its parents had already
resumed, so they were never signaled.

A sibling admitted before the claim could reach its park after the winner read
the parked Waits. The park write refused a claimed run, and that Wait halted its
branch without parking. A signal that still failed after the durable step's
retries left that sibling parked until its own timeout.

The wait-signal payload schema gained the `lifecycle-exit` literal, which
ADR-0015 counts as an incompatible durable protocol change during a mixed
deployment.

## Amendment: The Exit wake signals claimed Waits, and the listener window is accepted

Date: 2026-09-10

The Exit wake read the Execution's wait rows in `waiting` and in `resuming`
through `listActiveWaitStates`. A `resuming` row was a resume producer's claim
whose `wait-resume` signal might not have reached Inngest yet. When that send
failed, the producer released the row back to `waiting`, and the Exit claim then
refused every later resume claim, so a Wait the Exit wake had skipped stayed
parked until its timeout. The `lifecycle-exit` signal carried the row's resume
token, so it addressed the Wait behind a claimed row in the same way as a Wait
whose row was still `waiting`. `listWaitingStates` kept answering `waiting` rows
alone, because the runs panel offered a manual resume for each row it listed
and a Migration re-parked each row it paired.

A Wait wrote its row inside its durable prepare step and registered its Inngest
listener in a later step. An Exit signal sent between those two moments reached
a row that had no listener, and Inngest dropped it. That Wait stayed parked until
its own timeout, its next node was then refused under the claim, and its branch
halted. This window differed from the park-after-read window that the amendment
"The Exit winner wakes parked sibling Waits" described, where the sibling had
written no row yet when the winner read the parked Waits. This window was
accepted.
The Wait could not close it from its own side, because no code ran between
Inngest registering the listener and the wake. Closing it from the winning run
needed a sleep port and retry rounds in the scheduler, and the cost of leaving
it open was a sibling branch that halted at its own timeout.

## Amendment: A Cancel claim admits the Canceled side

Date: 2026-09-10

"After a Cancel or Exit claim, no new node may be admitted" was written for the
Started branch and applied to every write. It was therefore also true of the
Canceled outlet, whose nodes the same claim exists to run. A Canceled-side Wait
could not write its park row, so a graph whose Canceled outlet opened with a Wait
halted at that Wait and everything behind it never ran.

The claim guard became a question per side of the Lifecycle Node. Started-side
admission, park, re-park and resume stayed refused after either claim. Canceled-side
park, re-park, resume, Event wake and branch hand-off were admitted after a Cancel
claim and stayed refused after an Exit claim, which takes no graph outlet. The
guard `claimAdmits(side)` carries that in both backends, and `notExitClaimed`
carries the two writes that serve either side without knowing which one parked the
row: the wait-row claim and the run's re-park behind a sibling's open wait.

Which side a node sits on is read off the graph through
`CancelBoundary.isOnCanceledBranch`, which is derived from the edges rather than
from how far the run got, so a replay reaches the same answer as the attempt. No
column records it, and the engine carries it as `side` on the three writes that
park, re-park and resume a run.

A branch run reads no claim at any node boundary, so it cannot work the side out
for itself; the invoke payload states it, and a Canceled-side branch loads the
run's Cancel claim in a durable step before it walks anything. A Cancel claim read
by a Wait on the Canceled side is that Wait's own reason for existing rather than a
halt, so `readClaimWake` answers `null` for it. An Exit claim halts both sides.

The Runs panel's cancel button can now reach a run walking a Canceled outlet that
parked for a week. It answers a conflict rather than an internal failure, because
the run is canceling already and ending it would take the outlet away from it.

A canceling run releases the Entity's Concurrency slot at the claim; its
Canceled-side work runs beside any run a later Event opens for the same Entity.
The in-flight probe inside `startForEntity` still requires an unclaimed row, which
is what the rule was before this change, when a claimed run reached its terminal
row at once and freed the slot there.
