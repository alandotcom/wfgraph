# Rova Workflow Builder

A workflow engine that you embed in your application. It gives your team a visual editor.

Your code declares the vocabulary: the Events your application raises, together with the
actions and integrations you turn on. A person in the editor builds a workflow from it.

Rova is self-hosted. It runs on your infrastructure and uses your database.

**Two roles:**

| Role                 | Who                       | What they do                                                                                           |
| -------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Event Author**     | The developer who embeds  | Defines each Event in code, with its payload shape and the path to the value that identifies an entity |
| **Workflow Builder** | Their less technical team | Builds the graph in the editor and declares its Lifecycle Rules                                        |

**Where to read what:**

- `README.md` (this file): everything a host does.
- `CONTEXT.md`: the vocabulary, one paragraph for each term.
- `docs/adr/`: why each design was chosen.

## Runtime

- **API:** Hono (`packages/core/src/backend/api-app.ts`). It runs on each runtime that has
  `Request` and `Response`. This repository uses Node 24.
- **Database:** PostgreSQL, through postgres.js and Drizzle ORM.
- **Durable execution and events:** Inngest.
- **Editor:** a React SPA, served as a static bundle. TanStack Router handles the routes.
  The server state sits in TanStack Query, and Jotai owns the UI state.

A pnpm workspace monorepo:

```
packages/
  shared/    @rova/shared   Runtime-agnostic types, schemas, contracts (private)
  core/      @rova/core     Library entrypoints and backend
  client/    @rova/client   The workflow editor SPA
  plugins/   @rova/plugins  Built-in integrations (Acuity, Clerk, Linear, Resend, Slack, Twilio)

examples/    @rova/example-app  The host application that this repository runs (private)
```

`examples/app.ts` is the only server here. An adopter writes one in the same way
(`docs/adr/0006`).

## Embedding

`createRovaApp` returns a fetch handler: `(request: Request) => Promise<Response>`.

An import hands you a value and stops there. The `extensions` option turns that value on,
and it holds the full surface an application has.

```ts
import { createServer } from "node:http";
import { z } from "zod";
import { clientBundle } from "@rova/client";
import {
  createRequestListener,
  createRovaApp,
  defineAction,
  defineEvent,
} from "@rova/core";
import { builtInIntegrations } from "@rova/plugins";

// An Event your application raises. See "Defining an Event" below.
const appointmentCreated = defineEvent({
  name: "app/appointment.created",
  label: "Appointment created",
  description: "The app raises this Event for each new appointment.",
  schema: z.object({
    appointment: z.object({
      id: z.string().describe("Appointment ID"),
      startsAt: z.iso.datetime(),
    }),
  }),
  correlationPath: "appointment.id",
});

// One of your own actions, beside the actions of the built-in integrations.
const cancelAppointment = defineAction({
  id: "appointments/cancel",
  label: "Cancel Appointment",
  description: "Cancels an appointment and records the reason.",
  category: "Appointments",
  // This schema draws the config form. A field label is the key in title case
  // ("Appointment Id"). A description replaces that label.
  input: z.object({
    appointmentId: z.string().describe("Appointment ID"),
    reason: z.string().min(1),
  }),
  // What `handler` returns. This schema also drives template autocomplete.
  output: z.object({
    appointmentId: z.string().describe("Appointment ID"),
    status: z.string(),
    cancelledAt: z.iso.datetime(),
  }),
  // A throw fails the node. The run log shows the message.
  handler({ input }) {
    return {
      appointmentId: input.appointmentId,
      status: "cancelled",
      cancelledAt: new Date().toISOString(),
    };
  },
});

const rova = await createRovaApp({
  database: {
    url: process.env.DATABASE_URL!,
    // Rova puts its tables in "_workflows". This option names a different schema.
    schema: process.env.DATABASE_SCHEMA,
    migrations: { runOnStartup: true },
  },
  encryption: { key: process.env.INTEGRATION_ENCRYPTION_KEY },
  auth: (request) => hasValidSession(request),
  client: clientBundle,
  inngest: {
    id: "my-rova-app",
    baseUrl: process.env.INNGEST_BASE_URL,
    eventKey: process.env.INNGEST_EVENT_KEY,
    signingKey: process.env.INNGEST_SIGNING_KEY,
  },
  // The full extension surface, in one location.
  extensions: {
    events: [appointmentCreated],
    actions: [cancelAppointment],
    integrations: builtInIntegrations,
  },
});

// rova.fetch answers the API on /api/*. This call passes a client, so rova.fetch
// answers the editor on /* too.
createServer(createRequestListener(rova)).listen(3000);
```

`examples/app.ts` is the same call with four Events and one custom action. That file is
correct. If this file disagrees with it, this file is wrong.

### Mounting

A fetch-native runtime takes `rova.fetch` as it is:

```ts
Bun.serve({ port: 3000, fetch: rova.fetch }); // Bun
Deno.serve({ port: 3000 }, rova.fetch); // Deno
export default { fetch: rova.fetch }; // Cloudflare Workers
```

Express and Fastify speak `IncomingMessage` and `ServerResponse`.
`createRequestListener` does that translation. It needs Node 20 or later.

```ts
const app = express();
// Mount Rova before each body parser. Pass the same path as basePath.
app.use("/workflows", createRequestListener(rova));
app.use(express.json());
```

```ts
const app = Fastify();
await app.register(middie); // @fastify/middie, which runs in the onRequest hook
app.use("/workflows", createRequestListener(rova));
```

Two failures the adapter handles for you:

- Express strips the matched path from `req.url`, so the adapter reads `req.originalUrl`.
  It logs once when the mount path and `basePath` disagree.
- A body parser in front of Rova drains the request. Rova cannot rebuild the original
  bytes that the Inngest callback verifies a signature over. Such a request gets a 500 that
  names the fix.

### The editor

Pass the bundle and the editor turns on:

```ts
import { clientBundle } from "@rova/client";

const rova = await createRovaApp({ client: clientBundle, ... });
```

- Omit `client` and Rova answers 404 outside `/api`. That suits a host that puts the editor
  elsewhere, or drives workflows with Events alone.
- The option takes a directory that holds an `index.html`, so a custom build of the editor
  is the same call with a different bundle.
- Each of the two packages is independent of the other.

### Built-in integrations

The third-party SDKs stay in `@rova/plugins`. Pass them and they turn on:

```ts
import { builtInIntegrations } from "@rova/plugins";

const rova = await createRovaApp({
  // ...
  extensions: { integrations: builtInIntegrations },
});
```

- Each integration is exported by name too, for a host that lists some of the six.
- The editor shows what the server assembled. The action selector lists exactly the
  integrations you passed, and a connection can be stored for those alone.
- That list controls what reaches `createRovaApp`. The process still loads every SDK the
  package imports: three of the six carry one, and `@rova/plugins` imports all six as
  values. The static import buys the timing of a failure. A missing SDK stops the
  application at start-up, where a lazy import would let a single run fail much later.
- `@rova/plugins` peer-depends on `@rova/core`. A second copy means a second database
  handle, which the one-Rova-per-process rule prevents.

### The database options

Pass a `url`, or pass the separate fields. Use one form only. A mixed value fails to
compile, and Rova refuses the same mixture at runtime.

```ts
database: {
  host: "db.internal",
  port: 5432,
  user: "rova",
  password: process.env.PGPASSWORD!,
  database: "app",
  schema: "_workflows",
  maxConnections: 10,
  ssl: "require",
  migrations: { runOnStartup: false },
}
```

The separate fields reach postgres.js as fields, so a database name with a space, an IPv6
host, a unix-socket host, and `ssl` all work.

**`database.schema`** names the Postgres schema that holds Rova. The default is
`_workflows`. Rova declares the tables unqualified, and the `search_path` of the connection
puts them in place, so the schema name is a runtime option. Drop that one schema and Rova
leaves the database, migration journal included.

Three rules follow. Each fails loudly:

1. A schema name must be an unquoted lowercase identifier of 63 characters or less.
   `search_path` folds other letters to lowercase, and Postgres truncates a longer name.
2. A `url` must carry no `search_path` query parameter. That parameter reaches the start-up
   packet and outranks the option.
3. The connection must keep that start-up parameter. Behind PgBouncer, set
   `track_extra_parameters=search_path` (1.22 or later). A session-mode connection or a
   direct connection keeps it too.

`docs/adr/0005` gives the reasons and the guards.

### Migrations

Two entry points, one migrator.

**At start-up.** `database.migrations.runOnStartup` (default `false`) applies the pending
migrations before the HTTP server starts. `database.migrations.migrationsDir` names a
different source, resolved from the working directory. The default is the `drizzle/`
directory that `@rova/core` ships, found relative to the running code. Rova reads the
working directory for that one option, so your own `./drizzle` is safe.

**From CI or a release step**, before an instance boots:

```ts
import { migrateRovaDatabase } from "@rova/core/migrate";

await migrateRovaDatabase({
  url: process.env.DATABASE_URL!,
  // Or the separate fields. Add `schema` when Rova lives elsewhere.
  // `migrationsDir` sits here, flat, and takes no `migrations` key.
});
```

- It takes the same connection fields as the `database` option, and it closes the
  connection on the way out, so a one-shot process exits when the promise resolves.
- Run it from several places at once. It holds a session-scoped advisory lock, and each
  caller that waits wakes to an already-migrated database.
- Call it inside a process that already built an application. The connection belongs to the
  call and is closed with it.

**Why this entry point alone applies the shipped SQL.** The files are schema-agnostic, and
`search_path` that selects the schema rides on the connection that Rova opens. `psql` or a
different migration tool puts the tables in `public`. This repository's
`pnpm run db:migrate` is the same entry with the environment read in front
(`scripts/migrate.ts`).

## Defining an Event

An Event is a named payload shape that your application raises.

```ts
const paymentSettled = defineEvent({
  name: "billing/payment.settled",
  label: "Payment settled",
  description: "The billing service raises this Event when a charge clears.",
  schema: z.object({
    appointmentId: z.string().describe("Appointment ID"),
    amountCents: z.number().describe("Amount settled, in cents"),
    settledAt: z.iso.datetime(),
  }),
  correlationPath: "appointmentId",
});
```

The lifecycle role of an Event belongs to the editor. Each Workflow Builder declares there
which workflow it starts and which it cancels (`docs/adr/0007`).

`defineEvent` builds a value. Pass it in `extensions.events`, where assembly checks it and
names the Event in any error.

**`name` is the identity.** One Event covers one thing that happened. Declare
`appointment.created` and `appointment.canceled` as two Events, because the lifecycle model
states its rules over Event names. One umbrella Event with a subtype field is wrong.

**`schema` describes the payload as it arrives.** Write it in Effect Schema, Zod, or
arktype and pass it as it is. Rova needs both halves of Standard Schema from one object:

- the validate half checks an arriving payload;
- the JSON Schema half draws the field list in the editor.

An Event therefore requires a library that publishes both halves. A schema whose root is
another type than an object throws at definition and names the Event. A `description` on a
path replaces the label that the editor derives from the key ("Starts At").

**`correlationPath` names where the Entity Value sits.** It is typed against the payload
and admits a path that resolves to a string.

- Runs that share that value are about the same entity. Concurrency, Cancel Events, and the
  match of a Wait node act on it.
- Two Events describe one entity when their Entity Values are equal, also where their paths
  differ.
- The path is optional. The author of an imported Event often lacks one, so the Workflow
  Builder supplies it in the Lifecycle panel. The path of the builder outranks the path of
  the author in every case.

**A datetime field declares `format: "date-time"`.** That JSON Schema keyword gives the
field the before and after operators in the condition builder, and it ranks the field to the
top of a menu that asks for a date.

```ts
z.iso.datetime(); // Zod
type("string.date.iso").configure({ format: "date-time" }); // arktype
Schema.String.annotate({ format: "date-time" }); // Effect, by hand
```

An Event in Effect Schema annotates the keyword by hand, because Effect's own date schemas
leave it out ([Effect-TS/effect#6790](https://github.com/Effect-TS/effect/issues/6790)).
Add `.check(Schema.isPattern(...))` where a malformed value must be turned away.

### The umbrella source

For an existing bus that sends one name and cannot change. `source` separates the identity
of an Event from its transport. The identity stays the Rova name, so the lifecycle model is
untouched, and `when` becomes the filter of the listener.

```ts
const invoicePaid = defineEvent({
  name: "billing/invoice.paid",
  label: "Invoice paid",
  schema: Schema.Struct({
    type: Schema.String.annotate({ description: "Subtype" }),
    invoiceId: Schema.String.annotate({ description: "Invoice ID" }),
  }),
  correlationPath: "invoiceId",
  source: { event: "billing/webhook", when: { path: "type", equals: "paid" } },
});
```

- Each listener carries its filter as the `if` of its Inngest trigger, so the bus decides
  which Event a payload is. It invokes a listener only for a subtype an Event declares.
- Rova compiles the filter at definition, so an expression it cannot build fails in the
  build of whoever wrote it.
- Assembly refuses two Events on one source that both omit `when`.

### The intake gate

Send an Event with an Inngest client. The listener of that Event delivers it, so the run is
durable from the moment the send returns.

```ts
inngest.send({ name: "app/appointment.created", data: { appointment } });
```

**The gate is open by design.** Rova validates the declared fields and ignores a key that
the schema never heard of.

- The payload of an Event is the message of the host, and senders add fields routinely, so
  an additive change upstream must not stop intake.
- This is the one boundary in the repository that decodes this way. A declared field that
  drifts fails loudly, and an extra key passes in silence by choice.
- Rova logs a refusal and stops there, because a second attempt meets the same malformed
  payload.

Rova discards what the gate decoded to and carries the raw JSON on. Every consumer
downstream reads that JSON directly. A transform rewrites what the sender sent, and one
`Date` round trip breaks a wait match that compares a literal captured at park time.

## The Lifecycle model

A Workflow Builder declares the Lifecycle Rules in the Lifecycle panel:

- which Events start a run;
- which Events cancel one;
- the concurrency policy that applies to each Entity Value.

`CONTEXT.md` defines Lifecycle Node, Start Event, Cancel Events, Arriving Event, Concurrency,
Precedence, Refused Start, and Execution status in full. `docs/adr/0007` says why the model looks like
this. An Event Author designs against that shape.

## Writing an integration

The server half builds against `@rova/core/plugin` alone, so an outside package is written
the same way. That surface exports `defineIntegration`, `CredentialFields`, `CredentialsOf`,
`checkIntegration`, `StepFailure`, `StepBag`, `IntegrationTestResult`, `callExternal`,
`callExternalAsync`, and `ExternalTransport`. `@rova/core/testing` is a second entry, and
holds `runAction`, `actionData` and `actionError` for the integration's own suite.

The browser half is the one gap. `@rova/plugins/ui` exports the built-in icons and output
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
} from "@rova/core/plugin";
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
      // Rova checks each `key` against the schema.
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

**A handler takes one bag**, holding `input` (the decoded config), the credential reads,
`step`, and the run's identity: `runMode`, `executionId`, `nodeId`, `nodeName`,
`integrationId`. `defineAction` calls its handler the same way. One object rather than two
parameters is Inngest's shape, and it takes a later value with no new position for an author
to learn.

### What is remembered across a replay

A durable runtime re-runs the whole workflow function every time a run resumes, after a
sleep, after a wait, after a retry. **Rova wraps no handler body.** Work with a side effect
goes inside `step.run` or it happens again on every attempt:

```ts
const posted = yield* bag.step.run("post", callSlack(apiKey, ...));
```

You name the work; Rova prefixes the node it belongs to, so two nodes running the same
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

`docs/adr/0009` is why this is the author's job rather than Rova's.

### Effect handler or async handler

The six built-ins use an Effect, because `callExternal` answers one and a handler yields it
directly. An Effect handler fails with a `StepFailure`, and `HttpClient.HttpClient` is the
one service it may ask for. A host's own action takes the same three shapes, and
`@rova/core` exports `StepFailure` for the Effect one.

An `async` handler fails by a throw, and the message becomes the sentence in the run log:

```ts
handler: async ({ input, readCredentials }) => {
  const { MY_SERVICE_API_KEY } = await readCredentials();
  if (!MY_SERVICE_API_KEY) {
    throw new Error("MY_SERVICE_API_KEY is not configured.");
  }

  return { id: await createThing(MY_SERVICE_API_KEY, input.text) };
},
```

| Effect handler           | Async handler                 |
| ------------------------ | ----------------------------- |
| `yield* bag.credentials` | `await bag.readCredentials()` |
| `callExternal`           | `callExternalAsync`           |
| Fails with `StepFailure` | Fails by a throw              |

The rest of the contract is identical. One case is worth knowing: `readCredentials` rejects with the failure
a refused credential store raises, and Rova fails the node on it, naming the store in the
message. A handler that catches around the await turns that into whatever it answers next,
so catch narrowly.

### The config form

`input` draws it. Each key the schema declares becomes a field, labelled from its
`description` and required where the schema requires it.

`configFields` states what a schema cannot: a placeholder, a `template-textarea` row count,
a friendly `select` label, a `showWhen`, a group. An entry merges into the derived field of
the same key, property by property. `configFields` is optional, and a schema that already
says everything stands on its own.

Order follows your entries, and Rova draws each key you left out after them, in schema
order. A group takes its position from your list, because its placement is a decision you
make.

### Testing an integration

`@rova/core/testing` runs one action the way a workflow runs it, through the config decode,
the credential fetch, the handler and the output encode:

```ts
import { actionData, actionError, runAction } from "@rova/core/testing";

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

### Schemas at a step boundary

Write them in the library you already use. Effect Schema, Zod, arktype, anything that
publishes Standard Schema. What differs is how much Rova does with them.

**An Effect schema crosses its canonical JSON codec in both directions.** A step boundary is
JSON on both sides, so Rova runs `Schema.toCodecJson(schema)`, built once at definition.
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
run in the decode direction only. Rova validates its config, and its form and field list
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

### Three rules

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
Acuity is the worked example, and that lesson cost five actions.

`packages/plugins/src/AGENTS.md` is the full guide: the file layout, the external HTTP
layer, the config field types, and the test pattern.

## Package exports

| Entry                | What it is                                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@rova/core`         | The one host-facing entry. `defineEvent` and `defineAction` author the vocabulary. `createRovaApp` builds the application, with `RovaAppOptions`, `RovaApp` and the config types. `createRequestListener` mounts it on Express, Fastify or `node:http`. |
| `@rova/core/plugin`  | What an integration package builds against                                                                                                                                                                                                              |
| `@rova/core/testing` | `runAction`, `actionData` and `actionError`, for that package's own suite                                                                                                                                                                               |
| `@rova/core/migrate` | `migrateRovaDatabase`, for migrations without an application                                                                                                                                                                                            |
| `@rova/client`       | `clientBundle`, the built editor, passed to `createRovaApp` as `client`                                                                                                                                                                                 |
| `@rova/plugins`      | The built-in integrations as values, by name and as `builtInIntegrations`                                                                                                                                                                               |
| `@rova/plugins/ui`   | Their icons and output renderers as one record, imported by the browser alone                                                                                                                                                                           |

Rova cannot serialize a React component, so that last record is the one part of the catalog
that stays off `/api/extensions`. `@rova/shared` stays private, and the build inlines it
into whichever bundle needs it.

Each export except `createRequestListener` runs on a runtime with `Request` and `Response`.
`createRovaApp` already answers a fetch handler, so mounting it is two lines the host owns.
A published wrapper would charge an options type that reaccumulates each parameter the
server of the host takes.

### createRovaApp options

| Option                              | Required | Description                                                                           |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `basePath`                          | No       | Path the host mounts Rova at (default `/`)                                            |
| `auth`                              | Yes      | Predicate that decides who reaches the editor, or `"external"`                        |
| `database.url`                      | Yes¹     | PostgreSQL connection string                                                          |
| `database.host` and co.             | Yes¹     | `host`, `port`, `user`, `password`, `database`, in place of a URL                     |
| `database.schema`                   | No       | Postgres schema Rova keeps its tables in (default `_workflows`)                       |
| `database.maxConnections`           | No       | Connections the query pool can open (default 10)                                      |
| `database.ssl`                      | No       | `true`, `"require"`, `"allow"`, `"prefer"` or `"verify-full"`                         |
| `database.migrations.runOnStartup`  | No       | Apply the pending migrations at start-up (default `false`)                            |
| `database.migrations.migrationsDir` | No       | Custom migrations directory                                                           |
| `encryption.key`                    | Yes      | 64-character hex string. It encrypts the integration secrets                          |
| `inngest.id`                        | Yes      | Inngest application ID                                                                |
| `inngest.*`                         | No       | isDev, baseUrl, eventKey, env, signingKey, signingKeyFallback, serveOrigin, servePath |
| `extensions.events`                 | No       | `defineEvent` values                                                                  |
| `extensions.actions`                | No       | `defineAction` values                                                                 |
| `extensions.integrations`           | No       | `defineIntegration` values                                                            |
| `logger`                            | No       | A `RovaLogger` that takes each log line. The default is a console sink                |
| `client`                            | No       | The editor bundle to serve, from `@rova/client`                                       |

¹ `database` takes one arm of the two. `schema`, `maxConnections`, `ssl` and `migrations`
are valid on both.

Read these once:

- **`auth` decides who reaches the editor**, and Rova refuses to start without it. It
  prevents the quiet failure: an editor the internet reaches, running actions with
  credentials decrypted out of the `integrations` table. Pass a predicate
  `(request: Request) => boolean | Promise<boolean>` that reads the session your application
  already uses, or `"external"` when something in front of Rova already gates it. It covers
  the RPC, REST, OpenAPI, extensions, and SPA routes.
- **Two routes sit outside that gate:** the Inngest callback and the wait resume path. Their
  callers are machines, each carrying a signing key or a resume token. Rova alone knows which
  of its routes are which, which is why it takes the predicate as an option and applies it
  route by route.
- **Set `inngest.signingKey` on each deployment.** `/api/inngest` sits outside the gate
  because Inngest signs its callbacks, and that holds with a configured signing key alone.
  Without one the SDK runs in dev mode and skips the signature check, so an anonymous POST to
  that path can execute a workflow function with a payload of its choice. Rova logs an error
  at start-up when no key is set.
- **A mount under a sub-path takes `basePath`.** Rova builds its API prefix, the
  `<base href>` of the SPA, and each asset URL from it. A host that mounts at `/workflows`
  and omits it gets a client that requests its assets from the root.
- **Running Inngest is the job of the consumer**, self-hosted or cloud. `pnpm run dev` here
  starts it as a separate process.
- `createRovaApp` answers `{ fetch, basePath, dispose }`. `await dispose()` returns when the
  layers of the Effect runtime finalize. One Rova per process is the supported arrangement,
  because the database handle, the Inngest client, the encryption key and the assembled
  surface are global to the process.

## API endpoints

The base path is `/api`, under whatever `basePath` names. Rova builds the full route list
from `packages/shared/src/rpc/contracts.ts` and serves it live:

- `GET /api/openapi.json` for the document
- `GET /api/docs` for the browsable form

## Roadmap

- [ ] Authentication (user login, session management, role-based access)
