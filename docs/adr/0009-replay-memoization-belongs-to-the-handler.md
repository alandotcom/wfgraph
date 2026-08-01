# 9. Replay memoization belongs to the handler

Date: 2026-07-31

## Status

Accepted.

## Context

Inngest re-runs a workflow function's whole body every time a run resumes: after
a sleep, after a wait, after a retry. Only work handed to `step.run` is
remembered.

The scheduler wrapped every node in one memoized step, `node:${nodeId}`, so a
node that had already posted to Slack was skipped when the function retried for
a later node's fault. `lib/inngest/workflow-function.ts` stated the dependency
where `retries: 4` is set: "Each node runs inside its own memoized step, so a
retry resumes at the step that failed instead of replaying the graph from the
trigger. Every plugin action depends on this."

Two things were wrong with it.

A node was one unit, so its granularity was the whole handler. A handler that
read a system, decided something, and then wrote to a second system had no way
to say that the read was safe to repeat and the write was not. The wrapper
either remembered both or neither.

It also diverged from the runtime underneath. Inngest wraps no function body,
and an author who has written an Inngest function arrives expecting to declare
what is remembered. Rova declared it for them, in a place they could not see,
with no way to subdivide it.

## Decision

The wrapper goes. Every node runs unwrapped, and a handler is given `step`, whose
one verb is `run`. Work with a side effect goes inside it or it happens again on
every attempt.

```ts
handler: Effect.fn(function* (bag) {
  const apiKey = (yield* bag.credentials).SLACK_API_KEY;

  return yield* bag.step.run("post", callSlack(apiKey, ...));
});
```

Three things fell out of it.

**Rova namespaces the id.** An author writes `"post"` and the runtime sees
`node:${nodeId}:post`, so two nodes running the same action do not read one
another's stored result.

**A `StepFailure` travels as a value.** Inngest retries a step whose body throws,
and the function's own `retries: 4` is the count. A vendor refusing a request is
an answer that will not change, so throwing it out of a step would spend four
attempts on it. The bridge runs the work to a `Result` inside the step, stores a
plain `{ ok, value } | { ok, message }`, and re-raises on the far side. The node
then fails once, which is what it did before. Anything else that throws is a step
that failed, which the runtime retries, and that is the right answer for a
timeout or a 502.

**The run-log rows each became a step.** They used to sit inside the node's
wrapper. The open one has to be memoized: the handler between the two writes is
replayed from the top on every attempt, so an unmemoized open would insert a
second row per attempt rather than close the first. The close is memoized too, so
a replay does not repeat the update. Their failure policies are unchanged.

`sleep` and `waitForEvent` are deliberately not on `step`. A suspension inside an
action would leave its run-log row open across the suspension, and Inngest
unwinds to suspend, so `runWithStepLog`'s `catch` would close the row as an
error. The Wait node has the row-spanning design that handles this; nothing else
does. Suspension stays a Wait node's job.

## Consequences

At-most-once per node moves from Rova to the author. A handler that wraps nothing
runs its work on every replay.

**The trap to know:** a handler that wraps nothing still has memoized run-log
rows, so the run panel shows one row for however many times the work ran. The log
is not evidence that the work happened once.

What `step.run` answers round-trips through JSON. A `Date`, `Map`, `Set` or class
instance inside it changes shape when the run resumes. `core-replay.test.ts`
carries the worked case: a node answering a `Date` keeps that value outside the
step, because the output schema's encode refuses the string that comes back.

Every built-in handler gained one `step.run` call, and so did the example app's
`cancelAppointment`.

The residual risk `retries: 4` already named is unchanged: a non-idempotent call
that fails after its side effect landed is sent again on the retry. An idempotency
key passed to the vendor is still the answer to that, and `callExternal` still
carries one.

## Amendment, 2026-08-01

The close is no longer memoized. It was, on the reasoning above that a replay
should not repeat the update, and that traded one idempotent write for the row's
accuracy: a node that failed and then succeeded on a retry kept the first
attempt's error row and its message for good, because the memoized close never
ran again. `closeStepLogQuietly` is an UPDATE keyed by the row id, so repeating
it costs nothing and carries the latest verdict.

Only the open stays a step, which is what its INSERT needs. The paragraph above
stands as the reasoning at the time.

## Amendment, 2026-08-01

Three things about the boundary the wrapper left behind.

**A run that recorded a terminal status is not retried.** Both exits of
`executeWorkflow` write that record inside a memoized step, and
`ExecutionRepo.finishRun` updates an in-flight row alone, so a further attempt
of the function body replays the write from the memo and would be refused by the
database if it did not. A Wait node reached on such an attempt cannot park
either: `createWaitState` answers nothing once the execution row is terminal.
The handler therefore ends a failed run with Inngest's `NonRetriableError`.
`retries: 4` is unchanged and still governs a step, which is where ADR-0009 put
node-level retry.

**A closed row carries the elapsed of the attempt that closed it.** The open is
memoized, so the handle a replay reads back holds the clock of whichever attempt
inserted the row. The close derived its duration from that handle, and an early
node's row therefore grew with every wait the run sat through. The store is now
handed a duration rather than a start time. A Wait node's row still measures from
its own open, which is the whole time the run was parked.

**A refused credential read fails the node.** The wrapper's removal changed this
without the headers saying so: the rejection used to land in the node's memoized
step, and it now passes through `runWithStepLog`, which closes the row as an
error. Restoring the retry means opening a step boundary of its own for the read
inside `buildStep`, which nothing else needs; the contract is stated as it now
behaves instead, in `step-runner.ts`, `credential-fetcher.ts`, `define-step.ts`
and README.

Nothing new is memoized by any of the three. The surface a run's steps are
dispatched through now holds one credential read per integration, built per
invocation of the function body and never routed through `runtime.run`, which
would write decrypted secrets into the run's stored state.
