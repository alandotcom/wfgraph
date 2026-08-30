---
name: authoring
description: >
  defineIntegration shape: CredentialFields, CredentialsOf, inline action
  handlers, configFields, configOptions, input/output Standard Schema, test
  loader. Load when scaffolding an integration package against @wfgraph/core/plugin.
metadata:
  type: sub-skill
  library: wfgraph
  library_version: "3.1.1"
sources:
  - alandotcom/wfgraph:docs/integrations.md
---

This skill builds on wfgraph-core/integrations.

# defineIntegration

## Setup

```ts
import {
  type CredentialFields,
  type CredentialsOf,
  defineIntegration,
  StepFailure,
} from "@wfgraph/core/plugin";
import { Effect, Schema } from "effect";
import { createThing } from "#src/my-service/client";

const myServiceCredentials = {
  MY_SERVICE_API_KEY: { label: "API Key", type: "password" },
} satisfies CredentialFields;

export type MyServiceCredentials = CredentialsOf<typeof myServiceCredentials>;

export const myService = defineIntegration({
  type: "my-service",
  label: "My Service",
  description: "What this integration does",
  credentials: myServiceCredentials,
  test: async () => (await import("#src/my-service/test")).testMyService,
  actions: {
    "do-something": {
      label: "Do Something",
      description: "What this action does",
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.Struct({
        id: Schema.String.annotate({ description: "Item ID" }),
      }),
      configFields: [{ key: "text", placeholder: "Something to send" }],
      handler: Effect.fn(function* (bag) {
        const credentials = yield* bag.credentials;
        const apiKey = credentials.MY_SERVICE_API_KEY;
        if (!apiKey) {
          return yield* Effect.fail(
            new StepFailure({
              message: "MY_SERVICE_API_KEY is not configured.",
            })
          );
        }
        return { id: yield* createThing(apiKey, bag.input.text) };
      }),
    },
  },
});
```

`type` prefixes every action id (`my-service/do-something`). `test` is a loader
so the vendor call stays behind a dynamic import until "Test connection".

## Core Patterns

### Inline actions only

`bag.input` and `bag.credentials` are typed from that action's schemas and the
integration's credential record. Lifting the action or handler into a `const`
above `defineIntegration` drops those types.

`category` defaults to the integration `label`. `sideEffect: true` marks an
external write; the editor keeps those out of a Group.

### Config form

`input` draws fields. `configFields` adds what a schema cannot (placeholder,
`showWhen`, `provider-select`). `configOptions` load choices from the
connection; a provider answers options, fields, or `unavailable` — never leak
exception text (it can hold a key in a URL).

### Step-boundary schemas

Effect Schema crosses the canonical JSON codec both ways. Other Standard Schema
libraries validate in and out. Optional input uses `Schema.optionalKey`; output
from a vendor that may send null uses `Schema.optionalKey(Schema.NullOr(...))`.
Annotate output fields with `description`.

The browser UI record (`@wfgraph/plugins/ui`) is not a public host API for
outside packages today.

## Common Mistakes

### CRITICAL Register on import

Wrong:

```ts
import "./my-service"; // hoped this turned the integration on
```

Correct: export the value and pass `extensions.integrations: [myService]`.

Source: alandotcom/wfgraph:docs/integrations.md

### HIGH Lift the handler out of the actions record

Wrong:

```ts
const handler = Effect.fn(function* (bag: StepBag) {
  /* ... */
});
export const myService = defineIntegration({
  actions: { "do-something": { handler, input, output, label, description } },
});
```

Correct: write the handler object literal inside `actions` as in Setup.

Source: alandotcom/wfgraph:docs/integrations.md (The definition)

### HIGH Duplicate the action id as a string

Wrong:

```ts
actions: { "do-something": { id: "my-service/do-something", /* ... */ } };
```

Correct: the record key is the only slug. Assembly computes `${type}/${slug}`.

Source: alandotcom/wfgraph:docs/integrations.md

### MEDIUM Promise handler inside defineIntegration

Wrong:

```ts
handler: async ({ input, readCredentials }) => { /* ... */ },
```

Correct: `Effect.fn` and `yield* bag.credentials`. Promise is `defineAction`
and `test` / OAuth seams only.

Source: alandotcom/wfgraph:docs/integrations.md (Effect for integrations, Promise for host actions)
