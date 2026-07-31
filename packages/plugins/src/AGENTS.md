# Writing an integration

An integration is one value. `defineIntegration` holds its credential form, its
actions, and a loader for its connection test; `@rova/plugins` exports each of them
by name plus `builtInIntegrations`, and a host turns them on by passing that array to
`createRovaApp` under `extensions.integrations`. Nothing registers on import, so
dropping the line is what turns them off.

**Only the server imports an integration.** The editor learns the whole surface as
JSON from `GET /api/extensions`, so a vendor client, an SDK, a step handler and a
secret all sit safely in these files. Two things cannot cross that wire, and both
live in `ui.ts`: the icon and any custom renderer for a step's output, because a
React component cannot be serialized.

## The files

The minimum, which `slack/` and `twilio/` are:

```
plugins/[name]/
  index.ts           the integration: credentials, schemas, actions, metadata
  index.test.ts      what the definition contributes: slugs, credentials, fields
  [subject].test.ts  the handlers, each run with a context the case supplies
  client.ts          the vendor's HTTP API, over fetch
  client.test.ts     what the client puts on the wire
  test.ts            the connection test the credentials UI runs
  icon.tsx           the SVG icon component
  ui.ts              registers the icon, and any output renderer
```

A larger integration adds modules beside those rather than growing `index.ts`
without limit: `acuity/` has `payloads.ts` for the vendor's wire shapes and
`shared.ts` for the config parsers its eight actions share, `clerk/` has `types.ts`,
`metadata.ts` and a `components/` directory for its output renderer, `linear/` an
`errors.ts`. What stays in `index.ts` either way is the integration itself: the
credential form, each action's two schemas, its config fields, and its handler, all
in the file a reader opens to learn what the integration does. `acuity/` is the
largest at eight actions, and it lays them out one after another -- schemas,
handler, step -- so the `actions` record at the foot reads as a contents list.

A vendor SDK is a plain import of that file, and `src/index.ts` imports all six
integrations as values, so the three SDKs that survived (`@clerk/backend`,
`@linear/sdk`, `@fountain-bio/acuity`) are hard dependencies of `@rova/plugins` and
load with the package whatever a host goes on to list. What the static import buys
is the timing of a failure: an SDK that is missing fails at boot rather than inside
a run.

## index.ts

```ts
import {
  credentialFields,
  type CredentialsOf,
  defineIntegration,
  defineStep,
  StepFailure,
  type StepRunContext,
} from "@rova/core/plugin";
import { Effect, Schema } from "effect";
import { createThing, describeMyServiceFailure } from "#src/my-service/client";

// `credentialFields` exists for the `const` inference: each `envVar` has to stay a
// literal type, because the vocabulary below is derived from them.
const myServiceCredentialFields = credentialFields([
  {
    label: "API Key",
    type: "password", // "password" | "text" | "url"
    placeholder: "sk_...",
    configKey: "apiKey", // where the value is stored, and the form's own key
    envVar: "MY_SERVICE_API_KEY", // what a handler reads it as
    helpText: "Get your API key from ",
    helpLink: { text: "myservice.com/api-keys", url: "https://..." },
  },
]);

/** The keys a handler may read. A misspelled one fails to compile. */
export type MyServiceCredentials = CredentialsOf<
  typeof myServiceCredentialFields
>;

const doSomethingInput = Schema.Struct({
  inputField: Schema.String,
  // `optionalKey` for a field a builder may leave blank: the engine drops an
  // undefined-valued key on its way out of template resolution, so a blank field
  // reaches the step as an absent key.
  optionalField: Schema.optionalKey(Schema.String),
});

const doSomethingOutput = Schema.Struct({
  // The annotation is the field's description in the editor's autocomplete. It goes
  // on the base type before any `check`, or the check owns it and nests it where the
  // field reader cannot see it.
  id: Schema.String.annotate({ description: "Item ID" }),
  // `optional`, not `optionalKey`, on the way out: a handler that answers
  // `createdAt: undefined` on one path is describing a key that is present and
  // empty, and the encode refuses that under `optionalKey`.
  createdAt: Schema.optional(
    Schema.String.annotate({ description: "When it was created" })
  ),
});

export const myService = defineIntegration({
  type: "my-service", // matches the folder name, and prefixes every action id
  label: "My Service",
  description: "Brief description of what this integration does",
  credentials: myServiceCredentialFields,

  // The test reaches the vendor, so it stays behind a dynamic import until someone
  // presses "Test connection".
  test: async () => (await import("#src/my-service/test")).testMyService,

  // The record key is the action slug, and the only place it exists: the action id
  // "my-service/do-something" is computed at assembly and never written twice.
  actions: {
    "do-something": defineStep({
      label: "Do Something",
      description: "What this action does",
      category: "My Service",
      input: doSomethingInput,
      output: doSomethingOutput,
      // Each `key` is checked against the input schema, so a field the step cannot
      // read fails to compile. A key the schema requires needs a field marked
      // `required: true`, or assembly refuses the action.
      configFields: [
        {
          key: "inputField",
          label: "Input Field",
          type: "template-input",
          placeholder: "Enter a value or use {{NodeName.field}}",
          required: true,
        },
      ],
      handler: Effect.fn(function* (input, context) {
        // Credentials arrive as an effect, so a step that decides it has nothing to
        // do never reads the integration's secrets. Yielding it twice fetches once.
        const credentials = yield* context.credentials;
        const apiKey = credentials.MY_SERVICE_API_KEY;

        if (!apiKey) {
          return yield* Effect.fail(
            new StepFailure({
              message:
                "MY_SERVICE_API_KEY is not configured. Add it in Project Integrations.",
            })
          );
        }

        const item = yield* createThing(apiKey, input.inputField).pipe(
          Effect.mapError(
            (error) =>
              new StepFailure({
                message: `Failed: ${describeMyServiceFailure(error)}`,
              })
          )
        );

        return { id: item.id };
      }),
    }),
  },
});
```

A handler that wants its own credential vocabulary annotates its context:
`context: StepRunContext<MyServiceCredentials>`. Unannotated, it reads the open
record, where every key is `string | undefined`.

## What `defineStep` owns, and the two directions it runs

The config decode, the credential fetch, the run log rows, and the `StepResult`
envelope. A handler answers a value or fails with a `StepFailure`; there is no
result type to write and no Promise to touch.

A credential read that the store refuses fails with `CredentialsUnavailable`
instead, and a handler passes it on: that failure rejects the step, which is what
gets the node a second attempt, where a `StepFailure` fails it once. A helper of
your own that yields `context.credentials` names the type in what it answers --
`acuity/client.ts` is the worked example.

**Both directions go through the schema's canonical JSON codec.** A step boundary is
JSON on both sides -- the config came out of a jsonb column through template
resolution, and the result is memoized by Inngest -- so what runs is
`Schema.toCodecJson(schema)`. Three consequences worth knowing before writing a
schema:

- A transform works. Twilio's comma-separated Media URLs field is a
  `Schema.decodeTo` on the input schema, so the handler receives the list and
  nothing in it knows the field was ever text.
- **The output encode is a trim.** A key the output schema does not declare does not
  survive it. A step handing back a vendor object whole therefore describes every
  field it means to pass on: acuity names `certificate`, `package` and a form
  answer's `value` for exactly that reason, even though the picker can offer a path
  for none of them. `Schema.StructWithRest` over a `Schema.Record` rest is the other
  spelling, for a shape that is genuinely open.
- A `Date` in an output leaves as an ISO string, and a value that is not JSON fails
  the encode as a `StepFailure` naming the field. That is the guarantee a memoized
  step result needs.

**Which optional spelling, on which side.** The codec rewrites `optional(X)` to
`optionalKey(NullOr(X))`, so the three spellings differ in what they accept, and a
refusal on the way out fails the whole step:

| Spelling                 | absent key | explicit `null` | present `undefined` |
| ------------------------ | ---------- | --------------- | ------------------- |
| `optionalKey(NullOr(X))` | takes      | takes           | refuses             |
| `optional(X)`            | takes      | takes           | refuses             |
| `optionalKey(X)`         | takes      | refuses         | refuses             |
| `NullishOr(X)`           | refuses    | takes           | takes               |

So: **an input field is `optionalKey(X)`**, because the engine sends an absent key
for a field a builder left blank and never sends a null. **A vendor-derived output
field is `optionalKey(NullOr(X))`**, which is the only spelling that survives both
a key the vendor omitted and a null it sent. A handler writing a field on some paths
and not others uses the same spelling and writes `null` rather than `undefined`,
since the encode refuses the third column.

**Describe the wire, not the SDK.** An SDK's types are its own promise about
somebody else's JSON, and a typed client that casts the response without validating
it is not evidence. Acuity is the worked example and the lesson cost five actions:
its SDK declares a `calendarTimeZone` the API does not send and puts intake answers
one level above where they live, so every appointment action failed its encode on any
appointment with a form. Model what a recorded response contains, keep the fields a
handler cannot work without required, and make everything else tolerant. Then pin it
with a fixture built from that response and an assertion that runs the encode --
`acuity/appointments.test.ts` is the pattern, and a field-derivation test alone
would not have caught any of it.

**A handler asks for `HttpClient.HttpClient` and nothing else.** A handler that
yields an effect wanting more fails to compile rather than failing inside a workflow.
A step that genuinely needs another service is a conversation about what belongs in a
step's environment, settled in `define-step.ts`, not a type parameter widened here.

## The output schema, and what the editor derives from it

Assembly reads the output schema and refuses one it cannot use, naming the action.
The root is a `Schema.Struct`, since a downstream node addresses a payload by named
path. A `description` annotation on a path is what an operator reads beside it, and
it replaces the label the editor derives from the key, so it earns its place wherever
the key alone reads badly.

**A nested field that drops out does so in silence.** The count is taken at the root,
so a leaf inside an object or a list can vanish and assembly still succeeds. Two
shapes vanish: a union the reader cannot name, and a nullable nested inside an
optional, since `Schema.optional(Schema.NullOr(x))` puts an `anyOf` inside an
`anyOf`. Write `Schema.NullishOr(x)` for the second. `Schema.Number` on its own
describes itself as a number or one of the strings `"Infinity"`, `"-Infinity"` and
`"NaN"`, so a numeric field is
`Schema.Number.annotate({ ... }).check(Schema.isFinite())`.

**A moment in time says so with `format: "date-time"`** on the encoded side, which is the
whole of how the editor learns a field is a time: it gives the field before/after
operators in the condition builder and ranks it to the top of a menu asking for a date.
Effect emits it for no date schema of its own, `Schema.Date` included
([effect#6790](https://github.com/Effect-TS/effect/issues/6790)), so a step's schema
writes `isoTimestampString` from `@rova/core/plugin`, which annotates the base
type and checks the ISO pattern after it. The keyword alone draws the field and refuses
nothing. A handler that wants a `Date` decodes to one from there, and the output codec
encodes it back to the string.

**What the schema is checked against.** The handler's return type comes from it, so a
payload that drops a field or renames one fails to compile; the schemas are the
source of truth, and a handler's own types never widen them. Optionality is not part
of that check, because this repo leaves `exactOptionalPropertyTypes` off. The client
is where a vendor's answer is decoded, and that is the check that catches a field the
vendor typed loosely.

## client.ts

**Call vendors through `vendor-http.ts`, not their SDK.** `callVendor` takes a request
spec and answers an `Effect` holding the decoded body, over Effect's own
`HttpClient`. It owns the ten-second per-attempt timeout, the retry schedule, the
JSON read, the decode, and the three failures every vendor call can end in:
`VendorUnreachable` (nothing answered), `VendorRejected` (it answered and said no,
carrying its own error body), and `VendorUnreadable` (a success status whose body is
not the documented shape).

A `client.ts` is the adapter above that: the auth header, the endpoints, the vendor's
error-envelope schema, and a function saying what one of those failures means in
words a person reads. Its calls answer an `Effect`, which a step yields directly.
`runVendorCall` is the Promise seam for the one caller that is not an effect: a
connection test. Twilio's client is the one to copy.

A client's failure vocabulary is `VendorError` itself: a step maps one to a
`StepFailure` with `describeXFailure`, and a connection test, which reports more than
a sentence, reads the vendor's error body with a `readXError` of its own.

The retry policy is stated once, above `RETRY_ATTEMPTS`. Two retries with jittered
exponential backoff from 500ms, a `Retry-After` up to ten seconds replacing that
delay, and only for a request repeating cannot do twice: a GET or HEAD, a write
carrying an idempotency key, or a spec that sets `safeToRepeat` because the vendor
spells a read as a POST the way Slack does. Ten seconds of elapsed time is the
loop's whole budget. Inngest's function-level retry is the outer policy for anything
longer.

An SDK earns its place only when it carries protocol logic worth borrowing, which is
why `@clerk/backend` (JWT verification), `@linear/sdk` (a typed GraphQL client) and
`@fountain-bio/acuity` stayed while `twilio`, `resend` and `@slack/web-api` did not.
Those three keep their own transport and their own error handling, so they do not go
through `vendor-http.ts`.

## test.ts

The connection test the credentials UI runs. It is a Promise all the way out, because
that is the shape the UI calls it with, so it is where `runVendorCall` enters the
runtime and provides `VendorTransport`, the layer a `defineStep` handler already runs
with. That layer is exported from `@rova/core/plugin` rather than rebuilt per package,
because the `Context.Reference` caching it works around is the kind of thing that gets
fixed in one copy and not the other.

```ts
export async function testMyService(credentials: Record<string, string>) {
  const apiKey = credentials.MY_SERVICE_API_KEY;

  if (!apiKey) {
    return { success: false, error: "MY_SERVICE_API_KEY is required" };
  }

  // Format validation first, when the vendor's keys have a known shape: it costs no
  // request and names the problem more precisely than a 401 does.
  if (!apiKey.startsWith("sk_")) {
    return { success: false, error: "Keys should start with 'sk_'" };
  }

  const result = await runVendorCall(
    fetchMyServiceIdentity(apiKey),
    (error) => error
  );

  return result.ok
    ? { success: true }
    : { success: false, error: describeMyServiceFailure(result.failure) };
}
```

## ui.ts and icon.tsx

```ts
// ui.ts -- only the browser imports this
import { registerIntegrationUi } from "@rova/shared/plugins/ui-registry";
import { MyServiceIcon } from "./icon";

registerIntegrationUi("my-service", { icon: MyServiceIcon });
```

The icon is an SVG component with an `aria-label` and a `<title>`; take the path from
simpleicons.org. `outputComponents` beside it maps an action slug to a React renderer
for that step's output in the runs panel. Add the module to `src/ui.ts`, which is the
one import the browser makes.

## Config field types

| Type                | Description                                | Templates |
| ------------------- | ------------------------------------------ | --------- |
| `template-input`    | Single line, with `{{@nodeId:Label.path}}` | Yes       |
| `template-textarea` | Multi-line, same grammar                   | Yes       |
| `text`              | Plain text input                           | No        |
| `number`            | Numeric input                              | No        |
| `select`            | Dropdown over `options`                    | No        |
| `schema-builder`    | Structured output schema builder           | No        |
| `key-value`         | Dynamic key-value list                     | No        |
| `group`             | Collapsible section holding `fields`       | N/A       |

`showWhen: { field, equals }` hides a field until another holds a value.
`defaultExpanded` opens a group. A `select` may carry `defaultValue`.

`literal: true` keeps a field out of template resolution: the engine hands the step
what the builder typed, in every run mode. It is what a test destination declares,
since a run steering its own test address from its payload defeats the point of
nominating one. The engine reads the flag off the catalog, so no engine edit is
needed for the next integration that grows such a field.

## Adding one

1. Write the files above under `packages/plugins/src/[name]/`.
2. Export the integration from `src/index.ts`, by name and in `builtInIntegrations`.
3. Add `import "./[name]/ui";` to `src/ui.ts`.
4. `pnpm run type-check && pnpm run test && pnpm run fix`.
5. `pnpm run dev`, then add a connection, build a workflow on the action, and run it.

Naming: the folder is the integration `type` in kebab-case; a handler is
`[action]Handler`; the credential type is `[Name]Credentials`; the connection test
is `test[Name]`; the icon is `[Name]Icon`; environment variables are
`[NAME]_[FIELD]`.

## Testing

Test the handler, not the step: it is a function of `(input, context)` to an
`Effect`, so a case supplies the context it wants and runs it.
`twilio/send-sms.test.ts` is the pattern, with the credentials as an `Effect.sync`
that counts its reads and the vendor client as the stubbed seam. That file also runs
the assembled step through `implement`, which is the whole path a run takes: the
config decode, the handler, and the envelope.

`[name]/index.test.ts` beside it asserts what the definition contributes: the
credential vocabulary, the action slugs, and the field list
`requireOutputFieldsFromSchema` derives from each output schema. What `defineStep`
itself does around a handler is covered once, in
`packages/core/src/backend/extensions/steps/define-step.test.ts`.

`src/index.test.ts` runs `checkIntegration` over all six at module level, which is
every check `assembleExtensions` runs, so a bad definition fails that file's
collection. A host otherwise meets it as a startup crash, and a description missing
from one field of one output schema would reach a reviewer as a green suite. An
outside integration package should do the same with its own values: `checkIntegration`
is exported from `@rova/core/plugin` for it.
