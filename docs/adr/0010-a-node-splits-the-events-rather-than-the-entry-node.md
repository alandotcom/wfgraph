# 10. A node splits the Events, rather than the entry node

Date: 2026-08-01

## Status

Accepted.

## Context

ADR-0007 let one workflow name several Start Events, so one graph answers an
appointment being booked and being moved. Each Event carries its own payload, and
a node behind the Started outlet could be reached by any of them.

The editor answered that with a union. `unionPayloadFields` offered every path any
reaching Event declared, and grouped them under a section label saying which
Events carried each one. The label was the whole of the guard. Three things went
wrong behind it.

A path only some Events declared was offered as though every run carried it,
because nullability was read off the declarations found rather than off the
Events that declared nothing. A rescheduled appointment carries where it moved
from and a created one does not, and nothing said so.

A path the Events typed differently was offered as text, on the reasoning that a
template renders everything to text. That reasoning holds for a template and
fails everywhere else: the type decides a condition row's operators, and a
`timestamp` on one Event and a `string` on another have no shared answer.

Neither reached the run. A template naming a path the arriving payload lacks
renders to the empty string, so the failure surfaced as a wait that would not
parse its own duration, one node away from the mistake.

The Condition node could already narrow the Event set, through a rule on
`$event.name`, and `eventsReaching` read that narrowing back. Nothing required
it, and nothing about a Condition on the canvas says which Events leave by which
line.

## Decision

The Events are split by a node a builder places, the Event Split, and not by the
entry node.

Its outlets are derived: one per Event that can reach it, labelled with the
Event, with nothing to configure. A run leaves by the outlet naming the Event it
arrived on. An outlet nothing connects ends the run there, which is the rule an
unconnected Lifecycle outlet already follows.

Splitting stays optional. Several Event shapes flow into one branch for as long
as that branch reads only what they agree on, which is what lets one reminder
branch serve a booking and a reschedule while a separate branch sends a different
first email for each.

What a node may address is then stated rather than implied. `reachableEventFields`
reconciles the payloads of the Events reaching a node: a path all of them declare
keeps its type, a path some of them declare is nullable, and a path they type
differently carries the clash and no type. The editor and the save read that one
answer, so a picker that offers a path and a save that refuses it cannot drift
apart.

## Consequences

The entry node keeps its two outlets, and a graph written before this one still
loads: the Event Split is a node to add, not a shape to migrate to.

A type clash is refused at save rather than degraded to text. The editor renders
such a path unusable and names the disagreeing Events, so the refusal is a
backstop rather than the first a builder hears of it.

The editor's draft save runs the same battery as a real save, so a graph carrying
a refusable token does not autosave until it is fixed.

`duration` joined the schema field vocabulary in the same change. A wait's
duration input had no type it could ask for, so it ranked every payload field
instead of filtering, and offered a patient's name for a length of time.
