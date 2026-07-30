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
The payload path on an Event where its Entity Value sits. Declared per Event
by the Event Author; shown to the Workflow Builder, who supplies it when an
imported Event declares none.

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
An Event the Lifecycle Rules list as starting a run. When one arrives,
Concurrency applies first, then a new Execution enters through the Started
outlet carrying the payload.

**Cancel Event**:
An Event the Lifecycle Rules list as canceling runs. When one arrives, every
in-flight Execution with an equal Entity Value jumps to the Canceled outlet
at its next step boundary.

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
