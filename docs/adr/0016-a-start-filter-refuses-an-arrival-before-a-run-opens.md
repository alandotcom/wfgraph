# 16. A Start Filter refuses an arrival before a run opens

Date: 2026-09-01

## Status

Accepted.

## Context

ADR-0007 made an Event's lifecycle role the Workflow Builder's declaration, and
ADR-0010 moved the narrowing of an Event set off the entry node and onto a node a
builder places. Between them they answered which Events a workflow reacts to and
which branch each one takes. Neither answered whether a particular arrival is
worth a run.

A builder wanting `appointment.created` to start a run only for video
appointments had one arrangement available: place a Condition node behind the
Started outlet and leave its False line unconnected. That reads the right payload
and reaches the right verdict, and it arrives too late for three separate
reasons.

Concurrency has already run. `startWithConcurrency` opens the Execution row under
the lock that makes Concurrency a decision rather than a race, and it does that
before any node executes. Under newest-wins, an arrival the Condition node is
about to discard has already superseded the run that was in flight, so a rule
written to ignore an arrival ends the run that mattered instead. No arrangement
of nodes fixes that, because every node runs after the start.

An Execution row exists per arrival. A workflow filtering nine arrivals in ten
fills its run list with runs that walked one node and stopped, and the ten
percent that matter are what the builder is looking for.

The refusal is unreadable as a refusal. A run that ends on an unconnected
Condition False line is `completed`, indistinguishable from a run that did its
work.

The Wait node had already solved the same problem for the other half of the
lifecycle. A Wait Subscription carries a `match`, and an arrival that does not
satisfy it leaves the run parked. There was no equivalent on the start side.

## Decision

A Start Event carries an optional Start Filter: a condition the arriving payload
must satisfy before a run opens. It lives in the Lifecycle Rules as
`startFilters`, keyed by Event name, on the same grain as `correlationPaths` and
`connectionIds`, and its value is a serialized `ConditionModel` -- the same string
a Wait Subscription's `match` holds.

It is read in `applyLifecycleRules`, after the Event is confirmed to hold the
start role and before `startWithConcurrency`. That position is the decision. An
arrival that fails the filter opens no Execution, so Concurrency never sees it and
nothing in flight is displaced.

A refused arrival writes one `run_refused` audit row, which is what the Refused
Starts panel already reads. First-wins Concurrency and a disallowed manual start
write the same row for the same reason.

A filter that cannot be evaluated against the payload refuses the start too. This
is the rule `resume-waits.ts` already states for a wait match: the payload arrived
from outside and may carry anything, so a field of the wrong type is an arrival
the filter does not admit rather than a reason to proceed. Unlike the wait's, this
refusal writes a row, so it is visible.

Parked runs are untouched. A Start Filter governs whether a run opens; Precedence
still delivers the Event to the Wait Subscriptions of every run already in flight.

A manual run is not filtered. The Run button and the execute route are a person
asking for this run rather than an arrival being admitted, and a filter written
about a payload has nothing to say about that request.

This does not reverse ADR-0010. That decision was about routing -- which branch a
run takes once it exists -- and routing stays on a placed node. Admission is a
different question, it can only be answered before the run exists, and the entry
node is the only place that holds.

### Where the filter is evaluated

Delivery reads the filter off the published graph it has already loaded, and
compiles the model on the spot. The alternative was denormalizing the filter onto
`workflow_event_subscriptions`, the way `connection_id` was denormalized, which
would let a refusal happen before the graph read and preflight.

That was deferred. It buys one query and one preflight per refused arrival per
workflow, at the cost of a column in three schema definitions and a SQLite
schema-fingerprint bump, and nothing yet shows the cost of the read. The change
is available later without touching the stored shape of the rules.

The filter's own module is `packages/shared/src/lifecycle/start-filters.ts`,
beside `event-connections.ts` and for the same reason: a per-Event record on the
Lifecycle Rules brings a layout, a set of writers and two checks with it, and
those belong together rather than spread through the module that merely stores
the rules.

### Where a filter is validated

The two questions a graph is asked are split the way the batteries already split
them. Whether the model parses and compiles at all is the save battery's, beside
`validateWaitMatches`, and an unfinished filter passes there because a
half-authored rule is the ordinary state of one being written and every keystroke
autosaves.

Whether the filter can decide anything is the publish battery's, in
`checkStartFilters`. It refuses an unfinished model, an operand still holding a
`{{...}}` reference to a run that does not exist yet, and a rule reading a path
the filtered Event does not declare. The last is the one worth naming: such a rule
compiles and evaluates cleanly and reads false on every arrival, because the
compiler guards each field for presence, so the workflow simply stops starting.

`checkStartFilters` is reached from `checkPublishReadiness` alone, and
deliberately not from `validateWorkflowEvents`, which preflight runs on every
arrival. Inside preflight the declared-path refusal would answer
`graph_unrunnable` for the whole workflow the moment an Event Author renamed a
field, taking the Cancel Events down with it and writing no row anybody could
read. Left to publish, the same drift makes the filter read false and record a
Refused Start per arrival, which is a failure a builder can see. The check exists
to catch a rule while it is being written, so publish is where it belongs.

## Consequences

The editor collapses the filter onto the Start Events that agree. One control
stands for every Start Event while they hold the same rule, offering the fields
they all declare plus the row naming the arriving Event, and it splits into one
control per Event when a builder asks or when the rules diverge. The layout is
derived from the stored filters rather than stored as a flag, so no mode can
disagree with the rules it describes.

A rule is held to the declaration it was built against, in type as well as in
path: the compiler emits the operators of the type the rule stored, so a field
the Event Author has since retyped leaves a rule the payload cannot answer.
`conditionTypeOf` is shared with the editor's picker for that reason, so what the
builder was offered and what publish accepts are one definition.

An open record is checked at the record. The keys of one are exactly what no
schema lists, so a rule reading `tags.order` is admitted on the `tags` it sits
under, and `seedConditionModelForField` is the one place that turns a picked key
row into the rule shape the builder stores.

Two filters count as the same rule when they compile to the same CEL. The stored
model carries the group and rule ids the editor generated, so two Events given
the same rule separately hold identical meaning under different ids, and a
comparison of the stored text would leave a split group with no way back to one
control.

Adding a Start Event to a group that shares one filter carries the filter onto it,
unless that Event does not declare what the filter reads. Carrying it there would
manufacture the state the declared-path check exists to refuse, so the Event is
left unfiltered and the group shows one control per Event, which is the honest
picture: that Event really does start on everything.

The Condition-behind-Started arrangement keeps working and is still the right
answer when the decision is about which branch a run takes. A Start Filter
decides admission, and a Condition decides routing once a run exists.

A workflow whose Start Events declare no field in common cannot be filtered by one
control. The collapsed editor says so and points at filtering each Event
separately.

The build agent cannot write a Start Filter. Its `set_lifecycle_rules` tool takes
no filter parameter, matching `SetWait`, which takes no `match` either. Both gaps
close together when they close, and a record cannot survive a strict function
schema, so the parameter will be a list of structs when it arrives. That tool
replaces the whole rules object, so it now carries the filters it cannot write
across an edit and prunes the ones whose Start Event the edit dropped. A Start
Event the agent adds gets no filter, because inheriting one the agent cannot see
would hide the same decision in the other direction.
