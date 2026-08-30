---
name: testing
description: >
  runAction, actionData, actionError from @wfgraph/core/testing; checkIntegration;
  evolving an action under the same id; hidden for retire. Load when writing an
  integration suite or changing action config/output keys.
metadata:
  type: sub-skill
  library: wfgraph
  library_version: "3.1.1"
sources:
  - alandotcom/wfgraph:docs/integrations.md
---

This skill builds on wfgraph-core/integrations/authoring.

# Testing and evolving integrations

## Setup

```ts
import { actionData, actionError, runAction } from "@wfgraph/core/testing";
import { Effect } from "effect";
import { expect, it } from "@effect/vitest";

it.effect("sends the message", () =>
  Effect.gen(function* () {
    const answer = actionData(
      yield* runAction(myService, "do-something", {
        input: { text: "hello" },
        credentials: { MY_SERVICE_API_KEY: "key_1" },
      })
    );
    expect(answer).toEqual({ id: "item_1" });
  })
);
```

The slug is typed to declared actions. `input` is the encoded side (what a
builder typed). `actionData` throws if the step failed; `actionError` throws if
it succeeded. `credentials` may be an `Effect` to pin lazy reads.

Call `checkIntegration` in the defining package's suite. Assembly runs the
same check, so a bad definition fails the host that turned it on.

## Core Patterns

### Evolve under the same id

Published workflows pin a catalog fingerprint of action ids and config/output
**keys**, not handler bodies. Safe under one id:

- Add config keys with `Schema.optionalKey` only. Never rename or remove a key.
- Add output paths only. Never remove or rename a path downstream nodes reference.
- Tighten validation only when every published value still passes.
- Change handler logic inside an existing `step.run` id for work not yet memoized.
- Rename a `step.run` id when a side effect must run again for in-flight runs.

### Retire

Ship `my-service/send-v2` and set `hidden: true` on the old action. Hidden
actions stay registered for runs; the picker omits them. Delete the old action
only when no published version and no in-flight execution still references it.

## Common Mistakes

### HIGH Skip checkIntegration

Wrong: only unit-test the HTTP client.

Correct: `checkIntegration(myService)` plus `runAction` for each handler, so an
output schema the editor cannot flatten fails in this package.

Source: alandotcom/wfgraph:docs/integrations.md (Three rules)

### HIGH Remove a config key on a live action id

Wrong:

```ts
input: Schema.Struct({ text: Schema.String }); // dropped `channel`
```

Correct: add keys with `optionalKey`; for a breaking contract, new id +
`hidden: true` on the old one.

Source: alandotcom/wfgraph:docs/integrations.md (Evolving an action)

### HIGH Pass decoded handler input to runAction

Wrong:

```ts
runAction(twilio, "send-sms", { input: { mediaUrls: ["https://a"] } });
```

Correct: encoded side, e.g. the comma-separated text a builder typed, when the
schema transforms.

Source: alandotcom/wfgraph:docs/integrations.md (Testing an integration)

### MEDIUM Delete a hidden action while runs exist

Wrong: remove the old id from `actions` after shipping v2.

Correct: keep `hidden: true` until no publication and no in-flight execution
references it.

Source: alandotcom/wfgraph:docs/integrations.md (Retiring an action)
