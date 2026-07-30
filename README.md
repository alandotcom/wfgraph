# Rova Workflow Builder

Rova is a workflow engine a developer embeds in their app, with a visual editor
handed to the people who build workflows on top of it. The host app declares the
vocabulary in code: the Events it raises, the actions it offers, the integrations
it turns on. The person in the editor assembles a workflow out of that vocabulary
and declares how its runs live and die.

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

This is a pnpm workspace monorepo with four packages:

```
packages/
  shared/    @rova/shared   Runtime-agnostic types, schemas, contracts (private)
  core/      @rova/core     Library entrypoints and backend
  client/    @rova/client   The workflow editor SPA
  plugins/   @rova/plugins  Built-in integrations (Acuity, Clerk, Linear, Resend, Slack, Twilio)
```

`examples/app.ts` is the repo's only server. It is an adopter's app written the way
an adopter writes one, and `pnpm run dev` and `pnpm run start` both run it. See
`docs/adr/0006`.

## Embedding

`createRovaApp` returns a fetch handler with the shape
`(request: Request) => Promise<Response>`, so Bun, Deno, Cloudflare Workers, and
Node 18+ consume it directly. Import `@rova/core/app` for the factory and
`@rova/core` for the authoring helpers.

Nothing in Rova registers itself on import. The `extensions` option is the whole
surface an app has, and a line there is what turns each half on.

```ts
import { createServer } from "node:http";
import { Schema } from "effect";
import { clientBundle } from "@rova/client";
import { createAction, defineEvent, timestampField } from "@rova/core";
import { createRovaApp } from "@rova/core/app";
import { createRequestListener } from "@rova/core/node";
import { builtInIntegrations } from "@rova/plugins";

// An Event your app raises. Section "Defining an Event" below covers the parts.
const appointmentCreated = defineEvent({
  name: "app/appointment.created",
  label: "Appointment created",
  description: "Raised when a new appointment is booked.",
  schema: Schema.Struct({
    appointment: Schema.Struct({
      id: Schema.String.annotate({ description: "Appointment ID" }),
      startsAt: timestampField("When the appointment starts, ISO 8601"),
    }).annotate({ description: "The appointment this event is about" }),
  }),
  correlationPath: "appointment.id",
});

// An action of your own, beside the ones the built-in integrations bring.
const cancelAppointment = createAction({
  id: "appointments/cancel",
  label: "Cancel Appointment",
  description: "Cancels an appointment and records the reason.",
  category: "Appointments",
  // The config form is derived from this schema. A field's label comes from its
  // `description` annotation, which goes on the base type before any check: a
  // check would otherwise own the annotation and the derivation cannot see it.
  schema: Schema.Struct({
    appointmentId: Schema.String.annotate({ description: "Appointment ID" }),
    reason: Schema.String.annotate({
      description: "Cancellation reason",
    }).check(Schema.isMinLength(1)),
  }),
  // What `execute` answers with. The editor's template autocomplete is derived
  // from this schema, so there is no field list to write out beside it.
  outputSchema: Schema.Struct({
    appointmentId: Schema.String.annotate({ description: "Appointment ID" }),
    status: Schema.String.annotate({ description: "Cancellation status" }),
    cancelledAt: timestampField("ISO timestamp of cancellation"),
  }),
  execute({ payload }) {
    return {
      success: true,
      data: {
        appointmentId: payload.appointmentId,
        status: "cancelled",
        cancelledAt: new Date().toISOString(),
      },
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
`IncomingMessage` and `ServerResponse`. `@rova/core/node` does that translation and
needs Node 20 or newer.

```ts
import express from "express";
import { createRequestListener } from "@rova/core/node";

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
import { createRequestListener } from "@rova/core/node";

const app = Fastify();
await app.register(middie);
app.use("/workflows", createRequestListener(rova));
```

The adapter handles the two ways a Node mount goes wrong. Express rewrites
`req.url` to strip the path it matched on, so a listener mounted at `/workflows`
sees `/api/extensions` where the browser asked for `/workflows/api/extensions`; the
adapter reads `req.originalUrl`, where the full path survives, and logs once when
the host's mount path and `basePath` disagree. A body parser mounted ahead of Rova
drains the request, and Rova cannot re-create the original bytes that the Inngest
callback verifies a signature over, so such a request gets a 500 naming the fix.

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

`@rova/core` carries no vendor SDKs. The built-in integrations live in
`@rova/plugins` as values, and passing them is what turns them on:

```ts
import { builtInIntegrations } from "@rova/plugins";

const rova = await createRovaApp({
  // ...
  extensions: { integrations: builtInIntegrations },
});
```

Import two of the six by name instead and the rest are tree-shaken out. The editor
lists whatever the server assembled, so an integration a host left out is absent
from the action selector and can have no connection stored for it. Its SDK stays
out of the process too, because each handler's module is imported the first time
one of its actions runs.

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
`search_path` is what puts them there, so the schema name is a runtime option
rather than a build-time one. Dropping that one schema removes Rova from the
database, migration journal included.

Two consequences follow, and both fail loudly rather than quietly.

- A schema name has to be an unquoted lowercase identifier of at most 63
  characters. `search_path` would fold anything else to lowercase, or Postgres
  would truncate it, and the tables would then live somewhere other than the name
  says.
- A `url` may not carry a `search_path` query parameter. That parameter reaches the
  startup packet and outranks the option, so the two would disagree about where the
  tables are.

The connection has to keep the `search_path` startup parameter. Behind PgBouncer
that means `track_extra_parameters=search_path` (1.22 or newer);
`ignore_startup_parameters` is the wrong knob, since it drops the value rather than
passing it on. A session-mode or direct connection works as well. Migrations read
`current_schema()` back before applying anything and fail naming both schemas, so a
pooler that swallowed the parameter cannot migrate `public` by accident.

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

It takes the same connection fields the `database` option does. The connection is
given back on the way out, so a one-shot process exits when it resolves. Running it
from several places at once is safe: it holds a session-scoped advisory lock, and
the callers that lose the race wait and then find nothing to do. Postgres does not
serialize concurrent `CREATE SCHEMA` or `CREATE TABLE` of one name, so replicas
starting together would otherwise fail all but the first on a unique violation.

Calling it inside a process that already built an app works on one condition: the
config is compared field by field, `maxConnections` and `ssl` included, so pass the
object the app was given. A config differing anywhere reads as a second database
and is refused.

`@rova/core/migrate` exists because nothing else can apply the shipped SQL
correctly. Those files name no schema, and the `search_path` that decides which
schema they build rides on the connection Rova opens, so `psql` or another
migration tool would put the tables in `public`. This repo's `pnpm run db:migrate`
is that same entry with the environment read in front of it (`scripts/migrate.ts`),
which keeps the command used here daily and an adopter's CI job on one code path.

## Defining an Event

An Event is a named payload shape your app raises. It carries a name, a label, a
payload schema, and the Correlation Path where that payload holds its Entity Value.
It carries no lifecycle role: which workflow starts on it and which cancels on it
is each Workflow Builder's declaration in the editor (see `docs/adr/0007`).

```ts
import { defineEvent, timestampField } from "@rova/core";
import { Schema } from "effect";

const paymentSettled = defineEvent({
  name: "billing/payment.settled",
  label: "Payment settled",
  description: "Raised by the billing service when a charge clears.",
  schema: Schema.Struct({
    appointmentId: Schema.String.annotate({ description: "Appointment ID" }),
    amountCents: Schema.Number.annotate({
      description: "Amount settled, in cents",
    }).check(Schema.isFinite()),
    settledAt: timestampField("When the payment settled, ISO 8601"),
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
validate cannot define an Event.

**Every payload path needs a `description` annotation**, nested objects included.
The editor lists `appointment.startsAt` as its own entry in the template picker and
shows that text beside it, so a bare field reads as the word "string" to whoever is
building the workflow. A missing annotation throws at definition, naming the Event.

**`correlationPath` names where the Entity Value sits.** It is typed against the
payload and admits only a path resolving to a string, which is what an Entity Value
is. Runs sharing that value are about the same entity, which is what Concurrency,
Cancel Events, and a Wait node's match act on. Two Events describe one entity when
their Entity Values are equal, even when their Correlation Paths differ, which is
why `appointmentId` above agrees with `appointment.id` on an appointment Event. The
path is optional: an imported Event may have none its author knew to declare, and
the Workflow Builder supplies one in the Lifecycle panel.

**A datetime field says so with `timestampField`.** That is what annotates it as a
date-time on the encoded side, which gives the field before/after operators in the
condition builder and ranks it to the top of a menu asking for a date. `dateField`
is the same wire form with a `Date` in a handler, which an Event has no use for,
since an Event's decoded payload is discarded and the JSON the sender wrote is what
travels. A bare `Schema.Date` is refused, because a declaration has no encoding
chain to annotate and its description never reaches the JSON Schema.

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
build of whoever wrote it. Two Events on one source that both omit `when` are
refused at assembly.

### The intake gate

An Event reaches Rova two ways. Send it with an Inngest client:

```ts
inngest.send({ name: "app/appointment.created", data: { appointment } });
```

Or post it, which needs no Inngest client:

```
POST /api/events/app%2Fappointment.created
Authorization: Bearer <api key>
Content-Type: application/json
```

The route accepts and enqueues. It does not fan out inside the request, because
that would tie a run's durability to an HTTP connection, so the payload goes onto
the bus and the Event's own listener does the delivery. The answer names the Event
and a delivery id and says nothing about the workflows behind it, since this
endpoint answers third parties across origins. It sits outside the `auth` predicate
and checks an API key instead, and it answers `OPTIONS` with CORS headers for a
browser sender.

**The gate is open, on purpose.** Declared fields are validated and a key the schema
never heard of is ignored rather than refused. An Event's payload is the host's own
message and senders add fields routinely, so an additive change upstream must not
stop intake. This is the one boundary in the repo that decodes this way, and the
consequence is worth stating: drift on a declared field fails loudly, and drift by
addition is silent by choice. A refusal reaches an HTTP sender as a 400 naming the
paths that did not fit, and reaches the Inngest listener as a logged failure with no
retry, because a malformed payload does not improve on a second attempt.

What the gate decodes to is discarded, and the raw JSON travels on. Nothing
downstream consumes a typed value: the lifecycle reads a string at the Correlation
Path, a wait match evaluates over JSON, templates resolve strings, and JSONB holds
JSON. A transform would rewrite what the sender sent, and a `Date` round trip alone
is enough to break a wait match comparing a literal captured at park time.

## The Lifecycle model

This is what a Workflow Builder declares in the editor's Lifecycle panel, and what
an Event Author should understand about how their vocabulary gets used. The
Lifecycle Node is the workflow's entry node on the canvas. It carries the
**Lifecycle Rules** and two outlets, Started and Canceled. An unconnected outlet
ends the run quietly.

**Start Events** are the Events the rules list as starting a run. When one arrives,
Concurrency applies first, and then a new Execution enters through the Started
outlet carrying the payload. Manual starts are the other start source: the Run
button and the execute route, allowed or refused by the same rules.

**Cancel Events** are the Events the rules list as canceling runs. When one arrives,
every in-flight Execution with an equal Entity Value jumps to the Canceled outlet at
its next step boundary. The Canceled outlet is not drawn yet, so the rules refuse a
non-empty Cancel Event list at save and the panel says so. Until it lands, a
workflow ends its own runs from the canvas or the runs panel.

**Concurrency** is how many Executions may exist per Entity Value: one at a time
with newest wins, one at a time with first wins, or unlimited. Newest wins is how a
reschedule replaces a run. A start with no payload, which is a manual run, uses the
workflow itself as its entity, so Concurrency stays meaningful there.

**Superseded** is how an Execution ends when newest-wins Concurrency lets a newer
start take its place. It is quiet: no outlet fires, and run history records the
status.

**A Refused Start** is a start that opened no Execution. Three things cause one:
first-wins Concurrency found a run for the entity already going, the payload carried
nothing at the Correlation Path Concurrency needs, or a manual start was not
allowed. Each is recorded as an audit row with no Execution behind it, and the
editor's runs panel lists them beside the runs.

**Precedence** is one fixed order when an Event arrives. The Lifecycle Rules apply
first, and then the Event reaches the Wait Subscriptions of the runs that survived
them. There is no other ordering rule: a start always starts, and Concurrency
resolves multiplicity.

A Wait node's subscription is independent of all of this. It names any Event, with
an optional match over the arriving payload, and an Event needs no lifecycle role to
wake a wait.

An Execution ends with exactly one status: `completed`, `canceled`, `superseded`, or
`failed`.

## Writing an integration

`@rova/plugins` builds against `@rova/core/plugin` and nothing else, so an outside
package can be written the same way. That surface exports `defineIntegration`,
`credentialFields`, `CredentialsOf`, `checkIntegration`, `defineStep`, `StepFailure`,
`StepRunContext`, `IntegrationTestResult`, `VendorTransport`, and the two datetime
spellings `timestampField` and `dateField`.

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
// Your own vendor client. It answers an Effect, which the handler yields directly.
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
  // The test reaches the vendor, so it stays behind a dynamic import until
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
      // Each `key` is checked against the input schema, so a field the step
      // cannot read fails to compile.
      configFields: [
        { key: "text", label: "Text", type: "template-input", required: true },
      ],
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
survive it, so a step handing back a vendor object whole has to describe every field
it means to pass on. `Schema.StructWithRest` over a `Schema.Record` rest is the other
spelling, for a shape that is genuinely open.

**Which optional spelling, on which side.** The codec rewrites `optional(X)` to
`optionalKey(NullOr(X))`. An input field takes `optionalKey(X)`, because the engine
sends an absent key for a field a builder left blank and never sends a null. A
vendor-derived output field takes `optionalKey(NullOr(X))`, the one spelling that
survives both a key the vendor omitted and a null it sent.

**A handler either sits inline or arrives through `load`.** Exactly one of `handler`
and `load` is written, and a value carrying both fails to compile. `load` is a loader
for the handler's own module, and it earns its place two ways: a module importing a
vendor SDK stays out of a process that never runs one of its actions, and an
integration with eight actions is not a file anybody reads.

```ts
"do-something": defineStep({
  // ... the same metadata and the same two schemas
  load: async () =>
    (await import("#src/my-service/steps/do-something")).doSomethingHandler,
}),
```

**`checkIntegration` is the assembly check, exported for your own suite.** Assembly
calls it for every integration a host passes, so a bad definition fails the app that
turned it on. Calling it in the defining package's tests moves that failure to where
the author reads it, and it is what catches a missing annotation before review sees
a green run.

**Describe the wire, not the SDK.** An SDK's types are its own promise about somebody
else's JSON, and a typed client casting a response without validating it is not
evidence. Model what a recorded response contains, keep the fields a handler cannot
work without required, and make the rest tolerant. Acuity is the worked example, and
that lesson cost five actions.

`packages/plugins/src/AGENTS.md` is the full guide, with the file layout, the
vendor HTTP layer, the config field types, and the testing pattern.

## Package exports

- `@rova/core` is what a host authors vocabulary with: `defineEvent`,
  `createAction`, `timestampField`, `dateField`, and their types.
- `@rova/core/app` is `createRovaApp`, `RovaAppOptions`, `RovaApp`, and the
  re-exported config types.
- `@rova/core/node` is `createRequestListener`, for hosts on Express, Fastify, or
  `node:http`.
- `@rova/core/plugin` is what an integration package builds against.
- `@rova/core/migrate` is `migrateRovaDatabase`, for applying migrations without
  building an app.
- `@rova/client` is `clientBundle`, the built editor, passed to `createRovaApp` as
  `client`.
- `@rova/plugins` is the built-in integrations as values, by name and as
  `builtInIntegrations`.
- `@rova/plugins/ui` is their icons and output renderers, which only the browser
  imports. A React component cannot be serialized, so it is the one thing that
  cannot travel with the rest of the catalog over `/api/extensions`.

`@rova/shared` stays private and is inlined into whichever bundle needs it.

Everything except `@rova/core/node` runs on any runtime with `Request` and
`Response`. There is no published server wrapper: once `createRovaApp` returns a
fetch handler, a wrapper saves a consumer two lines and charges an options type that
reaccumulates every parameter the host's own server takes.

### createRovaApp options

| Option                              | Required | Description                                                       |
| ----------------------------------- | -------- | ----------------------------------------------------------------- |
| `basePath`                          | No       | Path the host mounted Rova at (default `/`)                       |
| `auth`                              | Yes      | Predicate deciding who reaches the editor, or `"external"`        |
| `database.url`                      | Yes¹     | PostgreSQL connection string                                      |
| `database.host` and co.             | Yes¹     | `host`, `port`, `user`, `password`, `database`, instead of a URL  |
| `database.schema`                   | No       | Postgres schema Rova keeps its tables in (default `_workflows`)   |
| `database.maxConnections`           | No       | Connections the query pool may open (default 10)                  |
| `database.ssl`                      | No       | `true`, `"require"`, `"allow"`, `"prefer"` or `"verify-full"`     |
| `database.migrations.runOnStartup`  | No       | Apply pending migrations at startup (default `false`)             |
| `database.migrations.migrationsDir` | No       | Custom migrations directory                                       |
| `encryption.key`                    | Yes      | 64-character hex string; encrypts integration secrets             |
| `inngest.id`                        | Yes      | Inngest application ID                                            |
| `inngest.*`                         | No       | baseUrl, eventKey, env, isDev, signingKey, serveOrigin, servePath |
| `extensions.events`                 | No       | `defineEvent` values                                              |
| `extensions.actions`                | No       | `createAction` values                                             |
| `extensions.integrations`           | No       | `defineIntegration` values                                        |
| `logger`                            | No       | Custom logger conforming to `RovaLogger`                          |
| `configureLogging`                  | No       | Enable built-in structured logging (default `true`)               |
| `client`                            | No       | The editor bundle to serve, from `@rova/client`                   |

¹ `database` takes either arm, never both. `schema`, `maxConnections`, `ssl` and
`migrations` are valid on both.

Notes worth reading once:

- **`auth` decides who reaches the editor**, and Rova refuses to start without it.
  The failure it prevents is the quiet one: an editor reachable from the internet,
  running actions with credentials decrypted out of the `integrations` table. Pass a
  predicate `(request: Request) => boolean | Promise<boolean>` reading whatever
  session your app already uses, or `"external"` when something in front of Rova
  already gates it. It covers the RPC, REST, OpenAPI, extensions, and SPA routes.
- **Three routes sit outside that gate**: the Inngest callback, the Event intake
  path, and the wait resume path. Those callers are machines carrying a signing key,
  an API key, or a resume token, and a session check would break all three. Which of
  Rova's routes are which is Rova's knowledge, which is why the predicate is an
  option rather than middleware wrapped around the mount.
- **Set `inngest.signingKey` on any deployment.** `/api/inngest` sits outside the
  gate because Inngest signs its callbacks, and that holds only with a signing key
  configured. Without one the Inngest SDK runs in dev mode and skips signature
  verification, so an anonymous POST to that path can execute a workflow function
  with a payload of its choosing. Rova logs an error at startup when no key is set.
- **Mounting under a sub-path means passing `basePath`.** Rova builds its API
  prefix, the SPA's `<base href>`, and every asset URL from it. A host that mounts at
  `/workflows` and omits it gets a client requesting its assets from the root.
- **Running Inngest is the consumer's job**, self-hosted or cloud. Rova does not
  spawn `inngest-cli`. This repo's `pnpm run dev` starts it as a separate process.
- `createRovaApp` returns `{ fetch, basePath, dispose }`. Awaiting `dispose()` waits
  for the Effect runtime's layers to finalize.
- One Rova per process is the only supported arrangement. The database handle, the
  Inngest client, the encryption key, and the assembled extension surface are
  process-global, so a second app with a different database URL silently aliases the
  first connection.

## API endpoints

Base path is `/api`, under whatever `basePath` names.

**Extensions and docs**

- `GET /api/extensions` the whole extension surface as one JSON catalog, which the
  editor reads once before its first render
- `GET /api/openapi.json`, `GET /api/docs`

**Events**

- `OPTIONS /api/events/:eventName`
- `POST /api/events/:eventName`

**API keys**

- `GET /api/api-keys`
- `POST /api/api-keys`
- `DELETE /api/api-keys/:keyId`

**Integrations**

- `GET /api/integrations`
- `POST /api/integrations`
- `POST /api/integrations/test`
- `GET /api/integrations/:integrationId`
- `PUT /api/integrations/:integrationId`
- `DELETE /api/integrations/:integrationId`
- `POST /api/integrations/:integrationId/test`

**Workflows**

- `GET /api/workflows`
- `POST /api/workflows/create`
- `GET /api/workflows/current`
- `POST /api/workflows/current`
- `GET /api/workflows/:workflowId`
- `PATCH /api/workflows/:workflowId`
- `DELETE /api/workflows/:workflowId`
- `POST /api/workflows/:workflowId/duplicate`
- `POST /api/workflows/bulk-lifecycle`
- `POST /api/workflow/:workflowId/execute`

**Runs**

- `GET /api/workflows/executions`
- `GET /api/workflows/:workflowId/executions`
- `DELETE /api/workflows/:workflowId/executions`
- `GET /api/workflows/executions/:executionId/status`
- `GET /api/workflows/executions/:executionId/logs`
- `GET /api/workflows/executions/:executionId/events`
- `POST /api/workflows/executions/:executionId/cancel`
- `POST /api/workflows/waits/:token/resume`

**Inngest**

- `GET /api/inngest`, `POST /api/inngest`, `PUT /api/inngest`

## Developing this repo

### Prerequisites

- Node 24 or newer
- pnpm 11 or newer, at the version the root `package.json`'s `packageManager` field
  names. Run `corepack enable` to have Node use it.
- PostgreSQL 15 or newer, local or remote
- Docker, optionally, for local Postgres through `docker compose`

### Environment

Create `.env.local` or `.env` with at least:

```env
DATABASE_URL=postgresql://workflow:workflow@localhost:55437/workflow_builder
```

The optional ones the example app reads:

```env
PORT=4017
HOST=127.0.0.1
INTEGRATION_ENCRYPTION_KEY=<64 hex characters>
RUN_DB_MIGRATIONS=false
MIGRATIONS_DIR=packages/core/drizzle
DATABASE_SCHEMA=_workflows
```

`pnpm run dev` sets `NODE_ENV`, `HOST` and `INNGEST_BASE_URL` itself, pointing the
last at the Inngest CLI it starts on port 8388.

`DATABASE_SCHEMA` is read by both paths. `pnpm run db:migrate` creates that schema
and `examples/app.ts` passes it to `database.schema`, so the app and the migrator
cannot disagree about where the tables are. Integration credentials are supplied
through the integrations UI, or through environment variables, depending on the
plugin.

### Running it

```bash
pnpm install
docker compose up -d   # optional, local Postgres
pnpm run db:migrate
pnpm run dev
```

The editor is at `http://localhost:5173`. `pnpm run dev` is three processes: the app
on 4017, Vite's dev server in `packages/client`, and the Inngest CLI. Vite compiles
the SPA and forwards `/api` to the app. Development hands `createRovaApp` no client,
because the option takes a built bundle.

`pnpm run start` is the other arrangement and one process. `NODE_ENV=production` is
what makes the example app hand the built bundle over, so Rova serves the editor,
its assets, and the API itself.

```bash
pnpm run build
PORT=4017 \
  DATABASE_URL=postgresql://workflow:workflow@localhost:55437/workflow_builder \
  INTEGRATION_ENCRYPTION_KEY=$INTEGRATION_ENCRYPTION_KEY \
  pnpm run start
```

A URL you hand to a sender outside the browser, a tunnel or a third-party service,
carries the app's port (4017) rather than the editor's.

### Scripts

- `pnpm run dev` the app, the client dev server, and the Inngest dev process
- `pnpm run dev:inngest` the Inngest dev process alone
- `pnpm run build` `pnpm -r build`, each package building itself in graph order
- `pnpm --filter @rova/client dev` the client dev server alone
- `pnpm --filter @rova/client build` `@rova/client` alone: the entry through tsdown,
  then the SPA through Vite into `packages/client/dist/client/`
- `pnpm run start` the app in production mode
- `pnpm run test` the vitest suite once, `pnpm run test:watch` in watch mode
- `pnpm run type-check` TypeScript
- `pnpm run lint` oxlint with type-aware rules
- `pnpm run knip` unused files, exports, and dependencies
- `pnpm run check` and `pnpm run fix` oxfmt, checking and fixing
- `pnpm run db:generate` the migration for a schema change
- `pnpm run db:migrate` pending migrations against `DATABASE_URL`, through Rova's
  own migrator

### Quality gates

Before committing:

```bash
pnpm run type-check
pnpm run lint
pnpm run test
pnpm run knip
pnpm run fix
pnpm run build
```

### Linking for development

To use `@rova/core` from another project:

```bash
# From the consumer project, point at this repo's core package by path.
# pnpm 11 takes a path here; the `--global` form of earlier versions is gone.
cd /path/to/consumer && pnpm link /path/to/rova/packages/core
```

A linked consumer resolves through the `"exports"` map to `packages/core/dist`, so
build the package before linking it and rebuild after changing it.

### Database tables

Defined in `packages/core/src/backend/lib/db/schema.ts`:

- `workflows`
- `integrations`
- `workflow_executions`
- `workflow_event_subscriptions`
- `workflow_execution_logs`
- `workflow_wait_states`
- `workflow_execution_events`
- `api_keys`

### Docker

The `Dockerfile` is out of date. It still targets Bun and a single-package `src/`
layout, so `docker build` fails. Tracked in
[#5](https://github.com/alandotcom/rova/issues/5). Use the
`pnpm run build && pnpm run start` path above until it is rebuilt.

## Roadmap

- [ ] Authentication (user login, session management, role-based access)
