# Rova Workflow Builder

Rova is a workflow engine a developer embeds in their app, with a visual editor
handed to the people who build workflows on top of it. The host app declares the
vocabulary in code: the Events it raises, the actions it offers, the integrations
it turns on. The person in the editor assembles a workflow out of that vocabulary
and declares how its runs live and die.

Own your automation: self-hosted, typed, and plugin-driven, running on your own
infrastructure against your own database. The developer who embeds it is the primary
audience and sets the bar; their less-technical teammates use the same editor, so a
workflow has to stay readable at a glance and safe to edit.

Two roles share the system and the whole design keeps them apart.

- The **Event Author** is the developer embedding the library. They define Events:
  names, payload shapes, and where each payload carries the value that identifies
  the entity a run is about.
- The **Workflow Builder** works in the editor. They assemble the graph and declare
  its Lifecycle Rules, which is every lifecycle decision for that workflow.

`CONTEXT.md` holds the full vocabulary. This file is the developer's path through
it, in the order you meet it.

## Runtime

The backend is a Hono API that runs on any JavaScript runtime with `Request` and
`Response`. This repo develops and deploys on Node 24. The editor is a standalone
React SPA served as a static bundle.

- API: Hono (`packages/core/src/backend/api-app.ts`)
- Database: PostgreSQL through postgres.js and Drizzle ORM
- Durable execution and events: Inngest
- Editor: React SPA on TanStack Router, TanStack Query for server state, Jotai for
  UI state

This is a pnpm workspace monorepo with four packages under `packages/`, beside
`@rova/example-app`:

```
packages/
  shared/    @rova/shared   Runtime-agnostic types, schemas, contracts (private)
  core/      @rova/core     Library entrypoints and backend
  client/    @rova/client   The workflow editor SPA
  plugins/   @rova/plugins  Built-in integrations (Acuity, Clerk, Linear, Resend, Slack, Twilio)

examples/    @rova/example-app  The host app this repo runs (private)
```

`examples/app.ts` is the repo's only server, and it is an adopter's app written the
way an adopter writes one (`docs/adr/0006`).

## Embedding

`createRovaApp` returns a fetch handler with the shape
`(request: Request) => Promise<Response>`, so Bun, Deno, Cloudflare Workers, and
Node 18+ consume it directly. `@rova/core` is the one import for the factory and
the authoring helpers.

Nothing in Rova registers itself on import. The `extensions` option is the whole
surface an app has, and a line there is what turns each half on.

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

// An Event your app raises. Section "Defining an Event" below covers the parts.
const appointmentCreated = defineEvent({
  name: "app/appointment.created",
  label: "Appointment created",
  description: "Raised when a new appointment is booked.",
  schema: z.object({
    appointment: z.object({
      id: z.string().describe("Appointment ID"),
      startsAt: z.iso.datetime(),
    }),
  }),
  correlationPath: "appointment.id",
});

// An action of your own, beside the ones the built-in integrations bring.
const cancelAppointment = defineAction({
  id: "appointments/cancel",
  label: "Cancel Appointment",
  description: "Cancels an appointment and records the reason.",
  category: "Appointments",
  // The config form is derived from this schema. A field's label is the
  // title-cased key ("Appointment Id"), and a description replaces it, so a
  // description earns its place where the key alone reads badly.
  input: z.object({
    appointmentId: z.string().describe("Appointment ID"),
    reason: z.string().min(1),
  }),
  // What `handler` answers with. The editor's template autocomplete is derived
  // from this schema, so there is no field list to write out beside it.
  output: z.object({
    appointmentId: z.string().describe("Appointment ID"),
    status: z.string(),
    cancelledAt: z.iso.datetime(),
  }),
  // Throwing fails the node, and the thrown message is what the run log shows.
  handler({ payload }) {
    return {
      appointmentId: payload.appointmentId,
      status: "cancelled",
      cancelledAt: new Date().toISOString(),
    };
  },
});

const rova = await createRovaApp({
  database: {
    url: process.env.DATABASE_URL!,
    // Rova keeps its tables in "_workflows" unless this names another schema.
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
  // The whole extension surface, in one place.
  extensions: {
    events: [appointmentCreated],
    actions: [cancelAppointment],
    integrations: builtInIntegrations,
  },
});

// rova.fetch answers the API under /api/* and, since a client was handed over,
// the editor under /*. On Node, createRequestListener translates the fetch
// handler into the IncomingMessage/ServerResponse pair node:http speaks.
createServer(createRequestListener(rova)).listen(3000);
```

`examples/app.ts` is this same call with four Events and one custom action, and it
is the canonical copy. Anything here that disagrees with that file is wrong.

### Mounting

A fetch-native runtime takes `rova.fetch` as it is:

```ts
Bun.serve({ port: 3000, fetch: rova.fetch }); // Bun
Deno.serve({ port: 3000 }, rova.fetch); // Deno
export default { fetch: rova.fetch }; // Cloudflare Workers
```

Express and Fastify sit on Node's `http` module, whose currency is
`IncomingMessage` and `ServerResponse`. `createRequestListener` does that
translation and needs Node 20 or newer.

```ts
import express from "express";
import { createRequestListener } from "@rova/core";

const app = express();
// Mount Rova ahead of any body parser, and pass the same path as basePath.
app.use("/workflows", createRequestListener(rova));
app.use(express.json());
```

Fastify reaches connect-style middleware through `@fastify/middie`, which runs it
in the `onRequest` hook, ahead of Fastify's body parsing:

```ts
import Fastify from "fastify";
import middie from "@fastify/middie";
import { createRequestListener } from "@rova/core";

const app = Fastify();
await app.register(middie);
app.use("/workflows", createRequestListener(rova));
```

The adapter handles the two ways a Node mount goes wrong. Express rewrites `req.url`
to strip the path it matched on, so the adapter reads `req.originalUrl` instead, and
logs once when the host's mount path and `basePath` disagree. A body parser mounted
ahead of Rova drains the request, and Rova cannot re-create the original bytes the
Inngest callback verifies a signature over, so such a request gets a 500 naming the
fix.

### The editor

`@rova/core` serves an API. The editor lives in `@rova/client`, and handing it over
is what turns it on:

```ts
import { clientBundle } from "@rova/client";

const rova = await createRovaApp({ client: clientBundle, ... });
```

Leave `client` out and Rova answers 404 outside `/api`, which suits a host
embedding the editor elsewhere or driving workflows by Event alone. The option
takes a directory holding an `index.html`, so a custom build of the editor is the
same call with a different bundle. Neither package depends on the other.

### Built-in integrations

`@rova/core` carries no third-party SDKs. The built-in integrations live in
`@rova/plugins` as values, and passing them is what turns them on:

```ts
import { builtInIntegrations } from "@rova/plugins";

const rova = await createRovaApp({
  // ...
  extensions: { integrations: builtInIntegrations },
});
```

Each is also exported by name, for a host listing some of the six rather than all of
them. The editor lists whatever the server assembled, so an integration a host left
out is absent from the action selector and can have no connection stored for it.
That narrows what reaches `createRovaApp` and not what the process loads: three of
the six carry an SDK, and `@rova/plugins` imports all six as values, so those
SDKs load with the package either way. What the static import buys is the timing of a
failure, since a missing SDK is then a crash at boot rather than one run failing.

`@rova/plugins` peer-depends on `@rova/core`. A second copy would mean a second
database handle, which is what one-Rova-per-process exists to prevent.

### The database options

`database` takes one `url` or the discrete fields, and the two arms are exclusive.
A mixed literal fails to compile and the same mixture is refused at runtime. The
fields reach postgres.js as fields, so a database name holding a space, an IPv6 or
unix-socket host, and `ssl` all work.

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

`database.schema` names the Postgres schema Rova lives in, `_workflows` unless a
host says otherwise. The tables are declared unqualified and the connection's
`search_path` is what puts them there, so the schema name is a runtime option rather
than a build-time one, and dropping that one schema removes Rova from the database,
migration journal included. Three rules follow, each failing loudly:

- A schema name has to be an unquoted lowercase identifier of at most 63 characters,
  since `search_path` would fold anything else to lowercase or Postgres would
  truncate it.
- A `url` may not carry a `search_path` query parameter, because that reaches the
  startup packet and outranks the option.
- The connection has to keep that startup parameter. Behind PgBouncer this means
  `track_extra_parameters=search_path` (1.22 or newer), and a session-mode or direct
  connection works as well.

`docs/adr/0005` has the reasoning and the guards.

### Migrations

Two ways in, and they run the same migrator.

**At startup.** `database.migrations.runOnStartup` (default `false`) applies pending
migrations before the HTTP server starts. `database.migrations.migrationsDir`
overrides where they are read from and is resolved from the working directory; the
default is the `drizzle/` directory `@rova/core` ships, found relative to the
running code. Nothing else is guessed from the working directory, so an embedder's
own `./drizzle` is never mistaken for Rova's.

**From CI or a release step**, before any instance boots:

```ts
import { migrateRovaDatabase } from "@rova/core/migrate";

await migrateRovaDatabase({
  url: process.env.DATABASE_URL!,
  // Or the discrete fields, and `schema` when Rova is not in `_workflows`.
  // `migrationsDir` sits here, flat, rather than under a `migrations` key.
});
```

It takes the same connection fields the `database` option does, and gives the
connection back on the way out, so a one-shot process exits when it resolves. Running
it from several places at once is safe, since it holds a session-scoped advisory lock
and the callers that lose the race wait and then find nothing to do. Calling it inside
a process that already built an app works too: the connection is the call's own and
takes no claim on the database.

`@rova/core/migrate` exists because nothing else can apply the shipped SQL correctly.
Those files name no schema, and the `search_path` deciding which schema they build
rides on the connection Rova opens, so `psql` or another migration tool would put the
tables in `public`. This repo's `pnpm run db:migrate` is that same entry with the
environment read in front of it (`scripts/migrate.ts`).

## Defining an Event

An Event is a named payload shape your app raises. It carries a name, a label, a
payload schema, and the Correlation Path where that payload holds its Entity Value.
It carries no lifecycle role: which workflow starts on it and which cancels on it
is each Workflow Builder's declaration in the editor (see `docs/adr/0007`).

```ts
import { defineEvent } from "@rova/core";
import { z } from "zod";

const paymentSettled = defineEvent({
  name: "billing/payment.settled",
  label: "Payment settled",
  description: "Raised by the billing service when a charge clears.",
  schema: z.object({
    appointmentId: z.string().describe("Appointment ID"),
    amountCents: z.number().describe("Amount settled, in cents"),
    settledAt: z.iso.datetime(),
  }),
  correlationPath: "appointmentId",
});
```

`defineEvent` registers nothing. The value goes to `createRovaApp` under
`extensions.events`, and assembly is where a mistake is caught, naming the Event.

**`name` is the Event's identity**, and one Event covers one thing that happened.
An app declares `appointment.created` and `appointment.canceled` separately rather
than one umbrella Event with a subtype field, because the lifecycle model states
its rules over Event names.

**`schema` describes the payload as it arrives.** Write it in Effect Schema, Zod, or
arktype and pass it as it is. Both halves of Standard Schema are needed from one
object: the validate half checks an arriving payload, and the JSON Schema half is
where the editor's field list comes from, so a library that describes only how to
validate cannot define an Event. A schema whose root is not an object throws at
definition, naming the Event. A `description` on a path replaces the label the editor
derives from the key ("Starts At"), so it earns its place where the key reads badly.

**`correlationPath` names where the Entity Value sits.** It is typed against the
payload and admits only a path resolving to a string. Runs sharing that value are
about the same entity, which is what Concurrency, Cancel Events, and a Wait node's
match act on, and two Events describe one entity when their Entity Values are equal
even where their paths differ. The path is optional, because an imported Event may
have none its author knew to declare; the Workflow Builder then supplies one in the
Lifecycle panel, and a builder's path outranks the author's either way.

**A datetime field says so with `format: "date-time"`**, the JSON Schema keyword the
field derivation reads off the encoded side. It gives the field before/after operators
in the condition builder and ranks it to the top of a menu asking for a date. Zod
emits it from `z.iso.datetime()` and arktype from
`type("string.date.iso").configure({ format: "date-time" })`. Effect emits it for no
date schema of its own
([Effect-TS/effect#6790](https://github.com/Effect-TS/effect/issues/6790)), so an
Event in Effect Schema annotates it by hand and adds its own
`.check(Schema.isPattern(...))` where a malformed value should be turned away.

### The umbrella source

`source` separates an Event's identity from its transport, for an existing bus that
sends one name and cannot change. Identity stays the Rova name, so the lifecycle
model is untouched, and `when` becomes the listener's filter:

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

Each listener carries its filter as its Inngest trigger's `if`, so the bus decides
which Event a payload is and a subtype nothing declared costs no invocation. The
filter is compiled at definition, so an expression that cannot be built fails in the
build of whoever wrote it. Two Events on one source that both omit `when` are refused
at assembly.

### The intake gate

An Event reaches Rova on the bus, sent with an Inngest client, and the Event's own
listener is what delivers it, so a run's durability is the bus's from the moment the
send returns.

```ts
inngest.send({ name: "app/appointment.created", data: { appointment } });
```

**The gate is open, on purpose.** Declared fields are validated and a key the schema
never heard of is ignored. An Event's payload is the host's own message and senders
add fields routinely, so an additive change upstream must not stop intake. This is the
one boundary in the repo that decodes this way, and the consequence is worth stating:
drift on a declared field fails loudly, drift by addition is silent by choice. A
refusal is a logged failure with no retry, since a malformed payload does not improve
on a second attempt.

What the gate decodes to is discarded, and the raw JSON travels on, because nothing
downstream consumes a typed value. A transform would rewrite what the sender sent, and
a `Date` round trip alone is enough to break a wait match comparing a literal captured
at park time.

## The Lifecycle model

A Workflow Builder declares Lifecycle Rules in the editor's Lifecycle panel: which
Event starts a run, which Events cancel one, and the concurrency policy per Entity
Value. `CONTEXT.md` defines Lifecycle Node, Start Event, Cancel Events, Concurrency,
Precedence, Refused Start, and Execution status in full, and `docs/adr/0007` says why
the model looks like this. An Event Author designs against the shape those define.

## Writing an integration

An integration's server half builds against `@rova/core/plugin` and nothing else, so an
outside package can be written the same way. That surface exports `defineIntegration`,
`credentialFields`, `CredentialsOf`, `checkIntegration`, `defineStep`, `StepFailure`,
`StepRunContext`, `IntegrationTestResult`, `callExternal`, `callExternalAsync` and
`ExternalTransport`.

Its browser half is the one gap. `@rova/plugins/ui` exports the built-in icons and output
renderers as one record keyed by integration type, and the editor imports that record by
name and provides it through React context, so an outside package has no route into it yet.

An integration is one `defineIntegration` value holding its credential form, a
`defineStep` per action, and a loader for its connection test.

```ts
import {
  credentialFields,
  type CredentialsOf,
  defineIntegration,
  defineStep,
  StepFailure,
} from "@rova/core/plugin";
import { Effect, Schema } from "effect";
// Your own client over `callExternal`. It answers an Effect the handler yields.
import { createThing } from "#src/my-service/client";

// `credentialFields` is an identity function with a `const` type parameter. It
// exists so each `envVar` stays a literal type, which is the vocabulary below.
const myServiceCredentials = credentialFields([
  {
    label: "API Key",
    type: "password",
    configKey: "apiKey", // where the value is stored
    envVar: "MY_SERVICE_API_KEY", // what a handler reads it as
  },
]);

/** The keys a handler may read. A misspelled one fails to compile. */
export type MyServiceCredentials = CredentialsOf<typeof myServiceCredentials>;

export const myService = defineIntegration({
  type: "my-service", // prefixes every action id
  label: "My Service",
  description: "What this integration does",
  credentials: myServiceCredentials,
  // The test reaches the system, so it stays behind a dynamic import until
  // someone presses "Test connection".
  test: async () => (await import("#src/my-service/test")).testMyService,
  // The record key is the action slug, and the only place it exists: the action
  // id "my-service/do-something" is computed at assembly.
  actions: {
    "do-something": defineStep({
      label: "Do Something",
      description: "What this action does",
      category: "My Service",
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.Struct({
        id: Schema.String.annotate({ description: "Item ID" }),
      }),
      // Optional. The form is derived from `input`, so this states only what a
      // schema cannot: a placeholder here. The label and the required flag
      // still come from the schema. Each `key` is checked against it, so a
      // field the step cannot read fails to compile.
      configFields: [{ key: "text", placeholder: "Something to send" }],
      handler: Effect.fn(function* (input, context) {
        // Credentials arrive as an effect, so a step that decides it has nothing
        // to do never reads them. Yielding it twice fetches once.
        const credentials = yield* context.credentials;
        const apiKey = credentials.MY_SERVICE_API_KEY;

        if (!apiKey) {
          return yield* Effect.fail(
            new StepFailure({
              message: "MY_SERVICE_API_KEY is not configured.",
            })
          );
        }

        return { id: yield* createThing(apiKey, input.text) };
      }),
    }),
  },
});
```

**`defineStep` owns everything around the handler**: the config decode, the
credential fetch, the run log rows, and the `StepResult` envelope the engine reads.
A handler answers a value or fails with a `StepFailure`. It writes no envelope and
touches no Promise, and it may ask for `HttpClient.HttpClient` and nothing else.

**The config form comes from `input`.** Every key the schema declares draws a
field, labelled from its `description` and marked required where the schema
requires it. `configFields` states what a schema cannot: a placeholder, a
`template-textarea` row count, a friendly `select` label, a `showWhen`, a group.
An entry merges into the derived field of the same key, property by property,
and a step needing none of that writes no `configFields` at all.

Order follows the entries you write, with any key you left out drawn after them
in schema order. That is why a group takes its position from your list: a group
has no key of its own to sort by, and where it sits is a decision.

The handler's `context` is typed with the open credential record, where every key is
`string | undefined`. A handler wanting its integration's own vocabulary annotates
the parameter as `context: StepRunContext<MyServiceCredentials>`, and a misspelled key
then fails to compile. The vocabulary is not inferred for you, because a type
parameter appearing only inside a context-sensitive argument would cost an inline
handler both parameter types and leave the whole handler unchecked.

**Both directions cross through the schema's canonical JSON codec.** A step boundary
is JSON on both sides, so what runs is `Schema.toCodecJson(schema)`, built once at
definition. That is what lets an input schema carry a transform: a comma-separated
text field decodes to a list on the way in, and a `Date` in an output encodes to an
ISO string on the way out. A handler answering with something its output schema
cannot encode fails the node once, naming the field path, rather than spending
retries on a certainty.

**The output encode is a trim.** A key the output schema does not declare does not
survive it, so a step handing back a system's object whole has to describe every field
it means to pass on. `Schema.StructWithRest` over a `Schema.Record` rest is the other
spelling, for a shape that is genuinely open.

**Which optional spelling, on which side.** The codec rewrites `optional(X)` to
`optionalKey(NullOr(X))`. An input field takes `optionalKey(X)`, because the engine
sends an absent key for a field a builder left blank and never sends a null. An
output field derived from a system's payload takes `optionalKey(NullOr(X))`, the
one spelling that survives both a key the system omitted and a null it sent.

**A handler sits inline, and that is the only spelling.** An integration is the one
file, however many actions it declares, and its SDK, when it has one, is a plain import of that
file. `@rova/plugins` imports all six built-ins as values, so their SDKs are hard
dependencies of the package and load with it whatever a host goes on to list (see
"Built-in integrations" above for what that timing buys).

**`checkIntegration` is the assembly check, exported for your own suite.** Assembly
calls it for every integration a host passes, so a bad definition fails the app that
turned it on. Calling it in the defining package's tests moves that failure to where
the author reads it, so an output schema the derivation cannot read is caught before
review sees a green run.

**Describe the wire, not the SDK.** An SDK's types are its own promise about somebody
else's JSON, and a typed client casting a response without validating it is not
evidence. Model what a recorded response contains, keep the fields a handler cannot
work without required, and make the rest tolerant. Acuity is the worked example, and
that lesson cost five actions.

`packages/plugins/src/AGENTS.md` is the full guide, with the file layout, the
external HTTP layer, the config field types, and the testing pattern.

## Package exports

- `@rova/core` is the one host-facing entry: `defineEvent` and `defineAction` to
  author vocabulary, `createRovaApp` (with `RovaAppOptions`, `RovaApp`, and the
  config types) to build the app, and `createRequestListener` to mount it on
  Express, Fastify, or `node:http`.
- `@rova/core/plugin` is what an integration package builds against.
- `@rova/core/migrate` is `migrateRovaDatabase`, for applying migrations without
  building an app.
- `@rova/client` is `clientBundle`, the built editor, passed to `createRovaApp` as
  `client`.
- `@rova/plugins` is the built-in integrations as values, by name and as
  `builtInIntegrations`.
- `@rova/plugins/ui` is their icons and output renderers as one record, which only
  the browser imports. A React component cannot be serialized, so it is the one
  thing that cannot travel with the rest of the catalog over `/api/extensions`.

`@rova/shared` stays private and is inlined into whichever bundle needs it.

Everything except `createRequestListener` runs on any runtime with `Request` and
`Response`. There is no published server wrapper: once `createRovaApp` returns a
fetch handler, a wrapper saves a consumer two lines and charges an options type that
reaccumulates every parameter the host's own server takes.

### createRovaApp options

| Option                              | Required | Description                                                                           |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `basePath`                          | No       | Path the host mounted Rova at (default `/`)                                           |
| `auth`                              | Yes      | Predicate deciding who reaches the editor, or `"external"`                            |
| `database.url`                      | Yes¹     | PostgreSQL connection string                                                          |
| `database.host` and co.             | Yes¹     | `host`, `port`, `user`, `password`, `database`, instead of a URL                      |
| `database.schema`                   | No       | Postgres schema Rova keeps its tables in (default `_workflows`)                       |
| `database.maxConnections`           | No       | Connections the query pool may open (default 10)                                      |
| `database.ssl`                      | No       | `true`, `"require"`, `"allow"`, `"prefer"` or `"verify-full"`                         |
| `database.migrations.runOnStartup`  | No       | Apply pending migrations at startup (default `false`)                                 |
| `database.migrations.migrationsDir` | No       | Custom migrations directory                                                           |
| `encryption.key`                    | Yes      | 64-character hex string; encrypts integration secrets                                 |
| `inngest.id`                        | Yes      | Inngest application ID                                                                |
| `inngest.*`                         | No       | isDev, baseUrl, eventKey, env, signingKey, signingKeyFallback, serveOrigin, servePath |
| `extensions.events`                 | No       | `defineEvent` values                                                                  |
| `extensions.actions`                | No       | `defineAction` values                                                                 |
| `extensions.integrations`           | No       | `defineIntegration` values                                                            |
| `logger`                            | No       | A `RovaLogger` every log line goes to; absent, Rova uses a console sink               |
| `client`                            | No       | The editor bundle to serve, from `@rova/client`                                       |

¹ `database` takes either arm, never both. `schema`, `maxConnections`, `ssl` and
`migrations` are valid on both.

Notes worth reading once:

- **`auth` decides who reaches the editor**, and Rova refuses to start without it. The
  failure it prevents is the quiet one: an editor reachable from the internet, running
  actions with credentials decrypted out of the `integrations` table. Pass a predicate
  `(request: Request) => boolean | Promise<boolean>` reading whatever session your app
  already uses, or `"external"` when something in front of Rova already gates it. It
  covers the RPC, REST, OpenAPI, extensions, and SPA routes.
- **Two routes sit outside that gate**: the Inngest callback and the wait resume path,
  whose callers are machines carrying a signing key or a resume token. Which of Rova's
  routes are which is Rova's knowledge, which is why the predicate is an option rather
  than middleware wrapped around the mount.
- **Set `inngest.signingKey` on any deployment.** `/api/inngest` is outside the gate
  because Inngest signs its callbacks, and that holds only with a signing key
  configured. Without one the SDK runs in dev mode and skips signature verification,
  so an anonymous POST to that path can execute a workflow function with a payload of
  its choosing. Rova logs an error at startup when no key is set.
- **Mounting under a sub-path means passing `basePath`.** Rova builds its API prefix,
  the SPA's `<base href>`, and every asset URL from it, so a host that mounts at
  `/workflows` and omits it gets a client requesting assets from the root.
- **Running Inngest is the consumer's job**, self-hosted or cloud. This repo's
  `pnpm run dev` starts it as a separate process.
- `createRovaApp` returns `{ fetch, basePath, dispose }`. Awaiting `dispose()` waits
  for the Effect runtime's layers to finalize. One Rova per process is the only
  supported arrangement, since the database handle, the Inngest client, the encryption
  key, and the assembled surface are process-global.

## API endpoints

Base path is `/api`, under whatever `basePath` names. The full route list is generated
from `packages/shared/src/rpc/contracts.ts` and served live rather than hand-maintained
here: `GET /api/openapi.json` for the document, `GET /api/docs` for the browsable form.

## Roadmap

- [ ] Authentication (user login, session management, role-based access)
