---
name: http
description: >
  callExternal and callExternalAsync, step.run memoization, StepFailure, Effect
  integration handlers versus Promise host actions, describe the wire not the SDK.
  Load when an integration calls a vendor HTTP API or wraps work for Inngest replay.
metadata:
  type: sub-skill
  library: wfgraph
  library_version: "3.1.1"
sources:
  - alandotcom/wfgraph:docs/integrations.md
---

This skill builds on wfgraph-core/integrations/authoring.

# External HTTP and replay

Workflow Graph wraps no handler body. A durable runtime re-runs the whole
function after a sleep, wait, or retry. Work with a side effect goes in
`step.run` or it happens again.

## Setup

```ts
const posted = yield * bag.step.run("post", callSlack(apiKey, channel, text));
```

`callExternal` answers an Effect (timeout, retry, JSON decode, three failures:
`ExternalUnreachable`, `ExternalRejected`, `ExternalUnreadable`). Yield it from
an integration handler. Connection tests and OAuth token writes use
`callExternalAsync` at the Promise edge.

An SDK earns its place only when it owns protocol (Clerk JWT verification,
Linear GraphQL). Do not wrap Twilio/Slack/Resend-style HTTP SDKs.

## Core Patterns

### JSON-only step results

What `step.run` answers must be JSON. A `Date`, `Map`, `Set`, or class instance
changes shape on resume. Carry timestamps as ISO strings.

### StepFailure fails the node once

```ts
return (
  yield *
  Effect.fail(new StepFailure({ message: "The vendor refused the request." }))
);
```

It travels as a value, so a refused call does not burn function-level retries.
Other throws inside a step are retried.

### A handler that wraps nothing still opens one memoized log row

The run panel then shows one row for however many times the work ran.

### Describe the wire

Model a recorded response with Effect Schema. Keep fields the handler reads
required; leave the rest optional/nullish. SDK types are not the wire.

## Common Mistakes

### CRITICAL HTTP call outside step.run

Wrong:

```ts
handler: Effect.fn(function* (bag) {
  return yield* sendMessage(apiKey, bag.input.text);
}),
```

Correct:

```ts
handler: Effect.fn(function* (bag) {
  return yield* bag.step.run("post", sendMessage(apiKey, bag.input.text));
}),
```

Without `step.run`, a Wait later in the graph sends the message again on resume.

Source: alandotcom/wfgraph:docs/integrations.md (What is remembered across a replay)

### HIGH Vendor SDK instead of callExternal

Wrong:

```ts
import { WebClient } from "@slack/web-api";
yield * Effect.promise(() => new WebClient(token).chat.postMessage(args));
```

Correct: a small client over `callExternal` (Twilio in `@wfgraph/plugins` is
the pattern). Keep an SDK only for JWT or typed GraphQL.

Source: alandotcom/wfgraph:docs/integrations.md (Three rules)

### HIGH Date inside step.run

Wrong:

```ts
yield * bag.step.run("fetch", Effect.succeed({ at: new Date() }));
```

Correct: `{ at: new Date().toISOString() }` and decode with the output schema.

Source: alandotcom/wfgraph:docs/integrations.md

### MEDIUM callExternalAsync inside an Effect handler

Wrong: Promise factory for `step.run` in an integration action.

Correct: `yield* bag.step.run(id, effect)` with `callExternal`. `callExternalAsync`
is the host / test / OAuth Promise bridge.

Source: alandotcom/wfgraph:docs/integrations.md (Effect for integrations, Promise for host actions)
