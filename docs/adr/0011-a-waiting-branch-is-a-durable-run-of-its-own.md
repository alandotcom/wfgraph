# 11. A waiting branch is a durable run of its own

Date: 2026-08-01

## Status

Accepted.

## Context

Inngest suspends a run rather than a branch. A workflow function is one
invocation, and a sleep parks the whole invocation, so every branch of the graph
stops at its next step boundary until the timer fires.

Two measurements against `inngest dev` fixed what that costs. A run holding two
outstanding pauses wakes once, at the later of the two, whichever was registered
first: a 20-second sleep beside a 90-second sleep resumed at the 90-second mark,
so the branch behind the short one ran 70 seconds after its own target. Issue #14
carries the timings.

`drainDeferredWaits` (7176afd) had already taken the neighbouring case. It holds
every Wait back until the fan-out settles, so a branch with no suspension in it
finishes before the run parks. It cannot reach this one, because the engine does
not decide when its invocation is resumed.

A third measurement decided the shape. A `step.invoke` of a second function
resolves with that function's own return value; a child cancelled by its own
`cancelOn` resolves instead with an `inngest/function.finished` envelope carrying
`_inngest.status === "Cancelled"`; a child that failed rejects with a `StepError`
carrying the child's error text. `cancelOn` reaches a child parked on
`step.sleep`, and a parent carrying no `cancelOn` survives it, settling about a
second after the cancel rather than at its last child's target.

## Decision

Each waiting branch becomes a durable run of its own. `drainDeferredWaits` is
where the hand-off happens: instead of entering the Wait, the node calls
`startBranch` on the durability port, which is `step.invoke` of a second
registered function, `workflow-branch`. The child runs the Wait and everything
behind it, and holds one pause, so it wakes on its own timer.

A second registration rather than a mode of the first, because `cancelOn` is
declared per function and the two need different ones.

**The child starts partway down the graph.** `executeWorkflowBranch` takes an
entry node id and walks from there. It writes no terminal record and its cancel
boundary is inert: the run that handed the branch off is the one that ends the
Execution and the one that routes a cancellation.

**Upstream outputs are read from the store; the ids the store cannot answer are
carried on the wire.** Templates behind a Wait address the nodes above it, which
the child never walked. A new `WorkflowStore.readNodeOutputs` reads them back out
of `workflow_execution_logs.output`. This is a judgement rather than a
measurement: it trades wire size against a dependency on rows having closed, and
an HTTP Request step's response body is what makes those rows large. The cost is
that a row whose close was refused leaves its template unresolved in the child.

Two things follow from reading rows rather than a traversal. A row holds the
step's payload while a traversal holds the `{ success, data }` envelope around
it, and every reader steps through one envelope, so a row read back is wrapped
again: a payload that is itself `{ success, data }` would otherwise be stepped
through twice below a Wait and once above it. And a row cannot say whether a
node released what is below it, since a node that halted its branch has an
output too, so the released ids travel on the invoke payload. They are ids, so
the size argument against carrying outputs does not reach them.

**A branch answers with what it walked, and that answer is decoded.** The
inherited outputs are left out of the value handed back, or a chain of waits
would return the whole Execution's outputs once per link. What comes back
becomes the run's own results and reaches its terminal record, so it crosses
`branchRunResultSchema` with the same `rejectUnknownKeys` the request half uses.

**Only the run that started a branch routes a cancellation.** Children are killed
by `cancelOn` on `workflow/branch.kill.requested`, which is a distinct event from
`workflow/run.cancel.requested` because the parent has to survive what kills them.
The child carries the run cancel as well, so a policy cancel that kills the parent
never leaves a branch working for a run that has ended.

**The rows a killed child leaves behind are swept by its parent.** A Wait opens
its run-log row before the sleep and closes it after, and Inngest stops calling a
cancelled function rather than throwing into it, so nothing inside the child can
close either that row or its wait state. The parent closes both, in one memoized
step keyed to the execution, at the moment it observes the kill: after the kill,
so no branch is alive to write to those rows, and before the Canceled outlet is
entered, since a Canceled branch opening with a one-week Wait would otherwise
leave a killed node reading Running for a week. It is safe because one event kills
every branch of a run at once.

## Considered Options

- **Fire and forget, the parent finishing without its children** rejected: it
  moves terminal status, duration and cancellation into new machinery for no gain
  here. The parent parks on the invoke instead, which costs nothing while a child
  sleeps.
- **Carrying upstream outputs on the invoke payload** rejected above, with the
  trade stated rather than hidden: it removes the closed-row dependency and puts
  every upstream output on the wire.
- **Reading the branch's own outcomes from the store too**, so the invoke answers
  with nothing but `finished` or `killed`, deferred rather than rejected. It
  would delete the response payload, its schema and the traversal's absorption,
  and it needs one thing this change does not have: an action node with no
  action type is recorded as failed and writes no row, so the store cannot see
  it. That row-less failure is worth removing on its own, and this is a reason
  to.
- **Letting the child route its own cancellation** rejected: two runs reading the
  same flag can both enter the Canceled outlet, and the outlet is the run's, not
  the branch's.
- **Keeping one run and ordering its waits** rejected: the executor decides when
  an invocation resumes, and no ordering the engine can express changes that.

## Consequences

Verified against `inngest dev` rather than inferred. Two sibling waits at 20s and
90s: the short branch's action landed 20.1 seconds in, while its sibling was still
parked, and the run completed at 91 seconds. A Cancel Event sent while both were
parked killed the branches, closed both node rows and both wait states as
`cancelled`, ran the Canceled outlet, and ended the Execution `canceled` 6.6
seconds after it started rather than at the 90-second mark. A Wait behind a Wait
works by the same route: a branch hands off to another of itself, through
`referenceFunction` by id, which is what keeps the self-reference from being a
cycle at construction.

`workflow_execution_logs.status` gains `cancelled`, which the status poll already
spoke: `getExecutionStatus` maps an open row of a terminal run onto that word at
read time. That mapping stays, as the backstop for a policy cancel, which kills
the parent too and leaves nobody to sweep.

An invoked run's event data carries Inngest's own `_inngest` routing metadata. The
branch event declares that key so the decode admits it and nothing else, and the
handler drops it before handing the payload to a branch of its own.

A run's trace is unchanged. Every branch writes to the same execution id, so the
run panel shows one run whatever it took to walk it. What changed is the Inngest
dashboard, which now shows one invocation per waiting branch beneath the run.

A node behind two Waits that belong to different branches is the case this does
not answer. A branch run inherits the released ids of the run that started it, so
a join whose other side is still parked in a sibling branch is reached by neither
run, and one whose other side closes at the same moment could be reached by both.
Nothing in the editor pushes a builder towards that shape, and the alternative is
a claim on the node's row that the engine does not have today.

The wait signal a Cancel Event sends to a parked run is now a second path to the
same stop: a branch the kill did not reach would otherwise stand until its wait
timeout. A wait woken that way halts its branch, which it did not need to do
before, since the run it woke read the cancel flag at that node and routed
itself. A branch run reads no flag, so without the halt it would carry on doing
real work for a run already ending.
