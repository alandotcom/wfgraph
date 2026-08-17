---
"@wfgraph/core": minor
"@wfgraph/client": minor
---

A disabled step now ends its branch, whatever kind of step it is, and the canvas
draws what that costs.

The engine used to stop only at a disabled Condition or Event Split. A disabled
lookup handed its null output on, and the step below read that null as an
answer. One rule replaces the two: a disabled node is skipped, recorded with a
null output, and nothing past it is scheduled. A saved workflow holding a
disabled step therefore runs less of itself than it did before, which a minor
bump carries because a disabled step was already a request to leave work out,
and the old behaviour left the step below reading a null it could not tell from
a real answer.

The editor mutes every step the run cannot reach, which until now was drawn only
for a Canceled subtree with no Cancel Event declared. A muted card sits at 50%
opacity and its incoming edge stops animating, so the dead part of a graph reads
as still. The disabled step itself keeps its own face, since a person needs to
tell the step they switched off from the steps that lost their path because of
it.

Disabled belongs to a Group as a whole. Selecting the frame offers the toggle
and writes the flag onto every member, which is what the engine walks. A member
selected on its own no longer offers it, the same way it offers no Delete, since
a frame with some members off and some on has no face it could honestly wear.
Grouping a step that was already off takes the whole frame with it.
