# Rova Workflow Builder

Rova lets a developer embed a workflow engine in their app and hand a visual
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
at its next step boundary.

**Arriving Event**:
The Event that put a run where it is: the Start Event it began on, and the
Cancel Event once it has taken the Canceled outlet. A manual run has none. A
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
Path Concurrency needs, or a manual start was not allowed. Recorded as an
audit row with no Execution behind it.

**Canceled Branch**:
The branch behind the Canceled outlet. Runs inside the same Execution, so it
reads the run's earlier node outputs and the canceling payload. Terminal: a
run inside it finishes it regardless of later Events. The Execution then ends
with status canceled.

**Precedence**:
One fixed order when an Event arrives: Lifecycle Rules apply first, then the
Event reaches the Wait Subscriptions of surviving runs. There is no other
ordering rule; a start always starts, and Concurrency resolves multiplicity.

### Waits

**Wait Subscription**:
A Wait node's own subscription to any Event, with an optional match
expression over the arriving payload. Independent of the Lifecycle Rules: an
Event needs no lifecycle role to wake a wait, and waking follows Precedence.

### Runs

**Execution**:
One run of one workflow, started by a Start Event, a schedule, or a manual
test. Ends with exactly one status: completed, canceled, superseded, or
failed.
_Avoid_: workflow (a workflow is the definition; an Execution is one run of it)

### Extensions

**Internal Extension**:
Work that runs inside the host's own process. Its Events arrive because the
host sent them, and its actions need no credential and reach nothing over the
network. `defineEvent` and `defineAction` are how one is written. Who wrote it
decides nothing: a published package of pure-compute actions is internal too.

**External System**:
A system Rova reaches over HTTP, holding credentials an operator supplied.
`defineIntegration` and `defineStep` are how one is written, and
`callExternal` is the one call that reaches it, carrying the timeout, the
retry schedule, and the rule about when a request may be sent twice.
_Avoid_: vendor (the retired word, which named who was called rather than what
the boundary guarantees)

**Connection**:
One set of stored credentials for one External System, with an id and a name.
An application may hold several for the same system, which is two Slack
workspaces or two Twilio accounts. An action node names the one it runs as.
