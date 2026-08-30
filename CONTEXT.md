# Workflow Graph

Workflow Graph lets a developer embed a workflow engine in their app and hand a visual
editor to the people who build workflows on top of it. Two personas share the
system, and most of this vocabulary exists to keep their responsibilities
apart: the Event Author supplies vocabulary, the Workflow Builder assigns it
meaning per workflow.

## Language

### Personas

**Event Author**:
The developer embedding the library who defines Events in code: their names,
their payload shapes, and where each payload carries its Entity Value.
_Avoid_: Trigger Author (retired with the authored trigger), developer
(ambiguous), integrator

**Workflow Builder**:
The person in the visual editor who assembles a workflow and declares its
Lifecycle Rules. Owns every lifecycle decision for their workflow.
_Avoid_: user (ambiguous), operator

### Events

**Event**:
A named payload shape declared in code: name, label, payload schema, and
Correlation Path. An Event carries no lifecycle role; roles are assigned per
workflow by the Workflow Builder.
_Avoid_: trigger (the retired authored bundle of events and policy)

**Integration Event**:
An Event declared on `defineIntegration` rather than by the host. The catalog
stamps `EventMetadata.integration`. A Workflow Builder must name a Connection
for each such Start, Cancel, or Wait Event at Publish.

**Webhook intake**:
The ungated POST that turns a vendor callback into an Event send. Addressed at
a Connection (`POST {basePath}/api/webhooks/{type}/{connectionId}`), mounted
on machine routes so host `auth` does not consume the body. The vendor
signature is the credential. The Connection id travels as delivery metadata,
not as a payload field.

**Correlation Path**:
The payload path on an Event where its Entity Value sits. The Event Author
declares one as the default; the Workflow Builder sets the path their own
workflow reads it at, and that one wins.

**Entity Value**:
The string identifying the entity a run tracks, read from a payload at that
Event's Correlation Path. Runs and payloads sharing an Entity Value are about
the same entity. Two Events describe the same entity when their Entity Values
are equal, even when their Correlation Paths differ. A start with no payload
(a schedule tick or a manual run) uses the workflow itself as its entity, so
Concurrency stays meaningful on scheduled workflows.
_Avoid_: correlation key (the retired implicit wait-match model)

### Lifecycle

**Lifecycle Rules**:
The Workflow Builder's per-workflow declaration of a run's lifetime: Start
Events, Cancel Events, and Concurrency. Lives on the Lifecycle Node. One
Event never holds the start role and the cancel role in the same workflow;
the editor rejects that configuration.
_Avoid_: Routing Policy (the retired per-event verb table), Replace, Ignore
(retired verbs of that table)

**Lifecycle Node**:
The workflow's entry node on the canvas. Carries the Lifecycle Rules and two
outlets, Started and Canceled. Scheduled and manual runs enter as start
sources on this node. An unconnected outlet ends the run quietly.

**Start Event**:
An Event the Lifecycle Rules name as starting a run. When one arrives,
Concurrency applies first, then a new Execution enters through the Started
outlet carrying the payload. A workflow may name several, which is how one
graph answers an appointment being booked and being moved; a node behind
Started may then be reached by any of them, and an Event Split is what tells
them apart.

**Event Split**:
A node whose outlets are the Events that can reach it, one each, derived
rather than configured. A run leaves by the outlet naming its Arriving Event,
and an unconnected outlet ends the run quietly. Optional: several Events share
one branch for as long as it reads only the paths they agree on (ADR-0010).

**Reachable Field**:
One path a node may address on the Lifecycle Node, as the Events reaching it
agree on it. A path all of them declare keeps its type; a path some of them
declare is nullable, because a run can arrive without it; a path they type
differently has no type at all, and needs an Event Split above the node before
anything can read it.

**Cancel Event**:
An Event the Lifecycle Rules list as canceling runs. When one arrives, every
in-flight Execution with an equal Entity Value jumps to the Canceled outlet
at its next step boundary. Stopping a sequence mid-graph is an unwired
Condition False, not a Cancel Event.

**Arriving Event**:
The Event that put a run where it is: the Start Event it began on, the Cancel
Event once it has taken the Canceled outlet, and the Event that woke an
event-mode Wait for everything below that Wait. A timeout that continues
below an event-mode Wait names none, so an Event Split there stops rather
than taking a Start Event outlet. A manual run names one of the Start Events
to stand in for, or none at all, and one naming none reaches an Event Split
and stops there, which is why such a graph refuses it outright. A
Condition node reads it as a field of its own, which is what lets one branch
answer several Events, since an outlet is one outlet however many feed it. Once
such a Condition has decided, the editor offers the nodes on each of its lines
only the Events still possible there.

**Concurrency**:
How many Executions may exist per Entity Value: one at a time with newest
wins, one at a time with first wins, or unlimited. Newest wins is how a
reschedule replaces a run; the retired word for that was Replace.

**Superseded**:
How an Execution ends when newest-wins Concurrency lets a newer start take
its place. Quiet: no outlet fires, and run history records the status.

**Refused Start**:
A start that opened no Execution, because first-wins Concurrency found a run
for the entity already going, the payload carried nothing at the Correlation
Path Concurrency needs, a manual start was not allowed, or a manual start named
no Event into a graph that splits on one. Recorded as an audit row with no
Execution behind it.

**Canceled Branch**:
The branch behind the Canceled outlet. Runs inside the same Execution, so it
reads the run's earlier node outputs and the canceling payload. Terminal: a
run inside it finishes it regardless of later Events. The Execution then ends
with status canceled. It cannot rejoin the Started branch.

**Join**:
A node with more than one incoming edge. The run reaches it only after every
predecessor has completed successfully and released what is below it
(AND-join), which is how two lookups run side by side and both feed the next
step. Fan-out onto those predecessors is unchanged: an ordinary action (or the
Lifecycle Node's Started outlet) already schedules every outgoing edge
together. A Wait on either arm, a join across exclusive Condition or Event
Split outlets, and a rejoin of Started with Canceled are refused.

**Group**:
A visual bundle of lookup steps plus an optional Condition. The engine walks
the children; the frame is editor chrome with one visible inlet and outlet.
Parallel entries share one predecessor. Lookup exits can remain separate when
they are terminal or their outgoing edges share a target and target handle;
the visible outlet represents every such edge. A Condition is the only exit,
and only True can continue. False with no outgoing edge ends that path. That is
how a sequence stops; it is not a Cancel Event. Sends stay outside the frame, which an action
declares with `sideEffect: true` and the editor refuses on. After a Wait, the
builder pastes the group so the next send reads a fresh fetch: node outputs are
memoized, and nothing above a Wait re-runs.

**Precedence**:
One fixed order when an Event arrives: Lifecycle Rules apply first, then the
Event reaches the Wait Subscriptions of surviving runs. There is no other
ordering rule; a start always starts, and Concurrency resolves multiplicity.

### Waits

**Wait Subscription**:
A Wait node's own subscription to any Event, with an optional match
expression over the arriving payload. Independent of the Lifecycle Rules: an
Event needs no lifecycle role to wake a wait, and waking follows Precedence.
The Events it parks on become the Arriving Event for everything below the
Wait, which is how an Event Split after a Wait tells those arrivals apart.

### Runs

**Workflow Version**:
An immutable copy of a workflow's graph, stored with the catalog fingerprint it
was sound against. A version is one of two kinds. A published version is what
each Publish creates; it takes the next number in sequence, and the workflow
points at the newest one. Event starts run the published graph and refuse a
workflow that has never been published. A draft snapshot is the graph a Draft
run freezes for itself. It has no number, stays out of the version history, and
is never published. A draft save edits the workflow's own graph and creates no
version. Published versions form durable history, and an Execution remains
pinned to the version it started against.

**Publish**:
The hard gate that turns a draft into a Workflow Version, and the only place a
graph is held to whether it can run: required fields, Events, Event Split
outlets, template references, connections, and unreachable subtrees. A draft
save asks none of that and stores whatever parses, because a half-built node is
the ordinary state of an editor session. Publish refuses a draft that is
semantically identical to the current version. A confirmed Publish advances
the version number even when the draft restores content from an older version.
A draft snapshot takes no number and never moves the pointer. The event
subscription index tracks the published graph, so a half-built draft cannot
start runs on an Event.

**Execution**:
One run of one workflow, started by a Start Event, a schedule, or a manual
test. Pins the Workflow Version it started against. Ends with exactly one
status: completed, canceled, superseded, or failed.
_Avoid_: workflow (a workflow is the definition; an Execution is one run of it)

**Draft run**:
One run of the graph on the canvas, started by the Run draft command. It freezes
that graph as a draft snapshot and pins itself to the snapshot, so a workflow
that has never been published can still run. Repeated runs of an unchanged
canvas share one snapshot, from the second run onward. A Draft run always reaches test
recipients, whatever the Published mode is, because nobody has reviewed the
graph it executes.
_Avoid_: current graph, working copy, unsaved changes (the canvas graph is the
Draft)

**Published run**:
One manual run of the published version, named by its number ("Run v7"). It
reaches the recipients the Published mode names, the same recipients an Event
start reaches.
_Avoid_: run workflow (the name must say which of the two graphs runs)

**Published mode**:
A per-workflow setting, live or test, deciding which recipients Events and
Published runs reach. Live means real recipients, and test means the test
recipients each integration defines. The setting does not affect a Draft run,
which is always a test run. The editor shows it beside the version it governs
("v7 · Live").
_Avoid_: run mode, workflow mode, production, sandbox

### Extensions

**Internal Extension**:
Work that runs inside the host's own process. Its Events arrive because the
host sent them, and its actions need no credential and reach nothing over the
network. `defineEvent` and `defineAction` are how one is written. Who wrote it
decides nothing: a published package of pure-compute actions is internal too.

**External System**:
A system Workflow Graph reaches over HTTP, holding credentials an operator supplied.
`defineIntegration` and `defineStep` are how one is written, and
`callExternal` is the one call that reaches it, carrying the timeout, the
retry schedule, and the rule about when a request may be sent twice.
_Avoid_: vendor (the retired word, which named who was called rather than what
the boundary guarantees)

**Connection**:
One authorization for one External System, with an id and a name. It can hold
credentials an operator entered or an OAuth grant the External System issued.
An application may hold several for the same system, which is two Slack
workspaces or two Twilio accounts. An action node names the one it runs as.
An integration-owned Event names the one it arrives through.

### Build Agent

**Build Agent**:
The chat panel in the editor that reads the extension catalog and the open
workflow, then edits the canvas on the Workflow Builder's behalf. It writes
through the same tools a person's clicks write through, so what it produces is
a workflow like any other. Turned on by a host passing a model key; absent
otherwise, panel and all.
_Avoid_: assistant, copilot (neither says what it acts on)

**Draft Document**:
The nodes and edges one turn of the Build Agent reads and edits. It arrives
with the request, lives for that request, and is handed back for the editor to
apply. It is never the canonical workflow: that stays in the editor and in the
database, and the Draft Document is a copy a turn is allowed to change.

**Turn**:
One exchange: the Workflow Builder's message, the model calls it makes, the
tools those calls run, and the answer it writes. A turn may go back to the
model many times, because reading the catalog and then writing a step are
separate steps of one request. Nothing of a turn is kept once it ends.
