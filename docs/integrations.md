# Writing an integration

How to author an integration against `@wfgraph/core/plugin`: `defineIntegration`, replay safety, Effect vs Promise, config forms, testing, and step-boundary schemas.

For the six built-ins in this repository, also see `packages/plugins/src/AGENTS.md`.

The server half builds against `@wfgraph/core/plugin` alone, so an outside package is written
the same way. That surface exports `defineIntegration`, `CredentialFields`, `CredentialsOf`,
`checkIntegration`, `StepFailure`, `StepBag`, `IntegrationTestResult`, `callExternal`,
`callExternalAsync`, and `ExternalTransport`. `@wfgraph/core/testing` is a second entry, and
holds `runAction`, `actionData` and `actionError` for the integration's own suite.

The browser half is the one gap. `@wfgraph/plugins/ui` exports the built-in icons and output
renderers as one record, keyed by integration type. The editor imports that record by name
and provides it through React context, so today that record is reachable from inside this
repository alone.

An integration is one `defineIntegration` value. It holds the credential form, an action
per record key, and a loader for the connection test.

```ts
import {
  type CredentialFields,
  type CredentialsOf,
  defineIntegration,
  StepFailure,
} from "@wfgraph/core/plugin";
import { Effect, Schema } from "effect";
// Your own client over `callExternal`. It answers an Effect the handler yields.
import { createThing } from "#src/my-service/client";

// The key names the credential: it is where the stored config holds the value
// and what a handler reads it under. The dialog asks in the order written here.
// `satisfies` rather than an annotation, which would widen `type` to `string`.
const myServiceCredentials = {
  MY_SERVICE_API_KEY: { label: "API Key", type: "password" },
} satisfies CredentialFields;

/** The keys a handler can read. A misspelled one fails to compile. */
export type MyServiceCredentials = CredentialsOf<typeof myServiceCredentials>;

export const myService = defineIntegration({
  type: "my-service", // prefixes each action id
  label: "My Service",
  description: "What this integration does",
  credentials: myServiceCredentials,
  // The test reaches the system, so it stays behind a dynamic import until
  // someone presses "Test connection".
  test: async () => (await import("#src/my-service/test")).testMyService,
  // The record key is the action slug, and its only home. Assembly computes the
  // action id "my-service/do-something".
  actions: {
    "do-something": {
      label: "Do Something",
      description: "What this action does",
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.Struct({
        id: Schema.String.annotate({ description: "Item ID" }),
      }),
      // Optional. `input` draws the form, so this states what a schema cannot.
      // Workflow Graph checks each `key` against the schema.
      configFields: [{ key: "text", placeholder: "Something to send" }],
      // One bag, the way an Inngest handler takes one. Destructure what you use.
      handler: Effect.fn(function* (bag) {
        // Credentials arrive as an effect, so a step reads them only when it
        // has work to do. Two yields fetch once.
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

**`defineIntegration` owns everything around the handler:** the config decode, the
credential fetch, the run log rows, and the `StepResult` envelope the engine reads. A
handler answers its output alone.

**An action is an object literal, and it stays inline.** That is what types its handler:
`bag.input` comes from that action's own `input` schema and `bag.credentials` from the
integration's own `credentials` record, with no annotation written anywhere. Lifting an
action, or its handler, into a `const` above the call loses the contextual type that does
it, so both are written where they are read.

**`category` defaults to the integration's `label`.** An action wanting a different
heading in the selector still writes one.

**`sideEffect: true` marks an action that changes something outside the workflow**: a
message sent, a record written or removed. It defaults to `false`, which says the action
only reads. The editor keeps an action carrying it out of a Group, because a Group is a
bundle a builder pastes again after a Wait so the next send reads a fresh fetch, and a
change to the outside world would land again with every paste. Note that this is a
narrower question than the replay sense of the phrase the next section uses, where a
lookup's own HTTP call counts too because `step.run` has to memoize it. `defineAction`
takes the same field.

**A handler takes one bag**, holding `input` (the decoded config), the credential reads,
`step`, and the run's identity: `runMode`, `executionId`, `nodeId`, `nodeName`,
`integrationId`. `defineAction` calls its handler the same way. One object rather than two
parameters is Inngest's shape, and it takes a later value with no new position for an author
to learn.

## What is remembered across a replay

A durable runtime re-runs the whole workflow function every time a run resumes, after a
sleep, after a wait, after a retry. **Workflow Graph wraps no handler body.** Work with a side effect
goes inside `step.run` or it happens again on every attempt:

```ts
const posted = yield* bag.step.run("post", callSlack(apiKey, ...));
```

You name the work; Workflow Graph prefixes the node it belongs to, so two nodes running the same
action never read one another's stored result. Wrap the call out to the system and leave
parsing, branching and shaping outside it: those are cheap to repeat, and keeping them out
keeps the stored value small.

Three rules:

- **What `step.run` answers must be JSON.** A `Date`, `Map`, `Set`, `Error` or class
  instance inside it changes shape when the run resumes. The compiler refuses one and names
  the field, so carry a timestamp as an ISO string and let the output schema decode it back.
  A class holding only data reads as a plain object and gets through: its fields survive the
  resume and its prototype does not, so `instanceof` is false on the far side.
- **A `StepFailure` fails the node once.** It travels back as a value rather than a throw,
  so a system that refused a request does not spend the retry budget on an answer that will
  not change. Anything else that throws inside is a step the runtime retries.
- **A handler that wraps nothing still opens one memoized log row.** The run panel then
  shows one row for however many times the work ran, so the log is not evidence it ran once.

`docs/adr/0009` is why this is the author's job rather than Workflow Graph's.

## Effect for integrations, Promise for host actions

**Integrations author with Effect.** The six built-ins and anything built against
`@wfgraph/core/plugin` use `Effect.fn`, because `callExternal` answers an Effect and a handler
yields it directly. Fail with a `StepFailure`. Durable work is
`yield* bag.step.run(id, effect)`. Credentials are `yield* bag.credentials`. Do not reach for
`readCredentials`, `callExternalAsync`, or a Promise factory for `step.run` in an integration
handler — those are the host bridge.

**Host `defineAction` stays Promise-first.** An adopter needs no Effect. An `async` handler
fails by a throw, and the message becomes the sentence in the run log. Durable work is
`step.run(id, () => promise)`. A connection test is also a Promise seam and uses
`callExternalAsync`.

```ts
// Host defineAction — Promise-first, no Effect required.
handler: async ({ input, readCredentials, step }) => {
  const { MY_SERVICE_API_KEY } = await readCredentials();
  if (!MY_SERVICE_API_KEY) {
    throw new Error("MY_SERVICE_API_KEY is not configured.");
  }

  return step.run("create", () => createThing(MY_SERVICE_API_KEY, input.text));
},
```

| Integration (`@wfgraph/core/plugin`) | Host `defineAction`                     |
| ------------------------------------ | --------------------------------------- |
| `Effect.fn` handler                  | `async` / plain function                |
| `yield* bag.credentials`             | `await bag.readCredentials()`           |
| `callExternal`                       | `callExternalAsync`                     |
| `yield* bag.step.run(id, effect)`    | `await bag.step.run(id, () => promise)` |
| Fails with `StepFailure`             | Fails by a throw                        |

Internally both arms of `step.run` share one Effect memoization path; the Promise overload is
a thin adapter. The rest of the contract (config decode, output encode, run log) is identical.
One case is worth knowing: `readCredentials` rejects with the failure a refused credential
store raises, and Workflow Graph fails the node on it, naming the store in the message. A handler that
catches around the await turns that into whatever it answers next, so catch narrowly.

## The config form

`input` draws it. Each key the schema declares becomes a field, labelled from its
`description` and required where the schema requires it.

`configFields` states what a schema cannot: a placeholder, a `template-textarea` row count,
a friendly `select` label, a `showWhen`, a group. An entry merges into the derived field of
the same key, property by property. `configFields` is optional, and a schema that already
says everything stands on its own.

Order follows your entries, and Workflow Graph draws each key you left out after them, in schema
order. A group takes its position from your list, because its placement is a decision you
make.

## Testing an integration

`@wfgraph/core/testing` runs one action the way a workflow runs it, through the config decode,
the credential fetch, the handler and the output encode:

```ts
import { actionData, actionError, runAction } from "@wfgraph/core/testing";

it.effect("sends the message", () =>
  Effect.gen(function* () {
    const answer = actionData(
      yield* runAction(myService, "do-something", {
        input: { text: "hello" }, // the resolved config, as a builder typed it
        credentials: { MY_SERVICE_API_KEY: "key_1" },
      })
    );

    expect(answer).toEqual({ id: "item_1" });
  })
);
```

The slug is held to the actions the integration declared, so a renamed action fails to
compile rather than leaving a case that covers nothing. `actionData` throws for a step that
gave up and `actionError` throws for one that did not, so neither hides the other's
outcome. `input` is the encoded side: a schema that transforms decodes it on the way in, so
a case supplies the text a builder would have typed.

`credentials` takes an `Effect` as well as a record, which is what a case pins the lazy
read with: a handler that decides it has nothing to send never runs it.

## Schemas at a step boundary

Write them in the library you already use. Effect Schema, Zod, arktype, anything that
publishes Standard Schema. What differs is how much Workflow Graph does with them.

**An Effect schema crosses its canonical JSON codec in both directions.** A step boundary is
JSON on both sides, so Workflow Graph runs `Schema.toCodecJson(schema)`, built once at definition.
`defineAction` reads and answers through the same codec, so an action of a host written in
Effect Schema gets this too. An input schema can therefore carry a transform:

```ts
// One text field decodes to a list on the way in.
input: Schema.Struct({
  urls: Schema.String.pipe(
    Schema.decodeTo(
      Schema.Array(Schema.String),
      SchemaTransformation.transform<readonly string[], string>({
        decode: (text) => text.split(",").map((entry) => entry.trim()),
        encode: (entries) => entries.join(","),
      })
    )
  ),
}),
// A `Date` encodes back to an ISO string on the way out.
output: Schema.Struct({
  sentAt: Schema.String.pipe(
    Schema.decodeTo(Schema.Date, SchemaTransformation.dateFromString)
  ),
}),
```

A handler that answers with something its output schema cannot encode fails the node once,
naming the field path, and keeps its retries for a failure that might clear.

**A schema from another library** publishes a validator and a JSON Schema. Both of those
run in the decode direction only. Workflow Graph validates its config, and its form and field list
derive as usual. What the handler answered passes on as it stands, so answer with JSON
there, because the engine memoizes a step result and replays it.

**That encode is a trim.** The output keeps the keys the schema declares, so a step that
hands back a whole object from a system must describe each field it means to pass on.
`Schema.StructWithRest` over a `Schema.Record` rest is the other spelling, for a shape that
is genuinely open. The other arm passes the object through whole.

**Each side takes its own optional spelling.** The codec rewrites `optional(X)` to
`optionalKey(NullOr(X))`.

```ts
// Input: a field a builder left blank arrives with its key absent, so `NullOr`
// is unnecessary here.
Schema.optionalKey(Schema.String);
// Output from the payload of a system: this one spelling survives a key the
// system omitted and a null it sent.
Schema.optionalKey(Schema.NullOr(Schema.String));
```

## Three rules

**A handler sits inline, and that is the only spelling.** An integration is the one file,
however many actions it declares, and its SDK, where it has one, is a plain import of that
file.

**`checkIntegration` is the assembly check, exported for your own suite.** Assembly calls it
for each integration a host passes, so a bad definition fails the application that turned it
on. Call it in the tests of the defining package and the failure lands where the author
reads it, so an output schema the derivation cannot read is caught before a review sees a
green run.

**Describe the wire.** The types of an SDK are its own promise about the JSON of somebody
else, and a typed client casts a response rather than validating it. Model what a recorded
response holds. Keep the fields a handler depends on required, and make the rest tolerant.
Twilio is the worked example: `twilioMessageSchema` in
`packages/plugins/src/twilio/client.ts` requires the three fields its handler reads and
leaves the rest optional and nullish.

For the file layout of the six built-ins, the external HTTP layer, config field types,
and the test pattern, see `packages/plugins/src/AGENTS.md`.

## Evolving an action

Keep the same action id when an in-progress run should resume without failing decode
and completed steps should keep their memoized results. Published workflows pin a
catalog fingerprint that hashes action ids and config/output **keys**, not handler
bodies or field types; Inngest replays completed `step.run` calls from stored JSON.

**Safe under one id:**

- **Add** config keys with `Schema.optionalKey` only. Never rename or remove a key:
  removal changes the fingerprint and fails waking nodes on pinned versions.
- **Add** output paths only. Never remove or rename a path downstream nodes may
  reference.
- **Tighten** validation only when every value a published graph could hold still
  passes. Stricter rules on the same keys do not change the fingerprint — the main
  footgun.
- **Change** handler logic inside an existing `step.run` id for work not yet memoized.
  Completed steps keep their cached answer.
- **Rename** a `step.run` id (for example `"post"` to `"post-v2"`) when a side effect
  must run again for in-flight executions.
- **Normalize** legacy config shapes with a decode transform on the input schema
  (see the comma-separated list example above).

## Retiring an action

When the contract cannot stay compatible under the same id, ship a new action
(for example `my-service/send-v2`) and set **`hidden: true`** on the old one. Hidden
actions stay registered for runs and in the catalog fingerprint; the editor's action
picker omits them, so new steps cannot select them. Workflows that already reference
the old id keep configuring and running it until you delete the action from code,
which you should do only when no published version and no in-flight execution still
references it.
