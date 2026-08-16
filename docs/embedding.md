# Embedding Workflow Graph

How to mount Workflow Graph in a host application: `createWfGraphApp`, the editor, integrations, database, migrations, package exports, options, logging, and tracing.

`createWfGraphApp` returns a fetch handler: `(request: Request) => Promise<Response>`.

An import hands you a value and stops there. The `extensions` option turns that value on,
and it holds the full surface an application has.

```ts
import { createServer } from "node:http";
import { z } from "zod";
import { clientBundle } from "@wfgraph/client";
import {
  createRequestListener,
  createWfGraphApp,
  defineAction,
  defineEvent,
} from "@wfgraph/core";
import { wfPostgres } from "@wfgraph/core/postgres";
import { builtInIntegrations } from "@wfgraph/plugins";

// An Event your application raises. See docs/events.md.
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

const wfgraph = await createWfGraphApp({
  persistence: wfPostgres({
    url: process.env.DATABASE_URL!,
    // Workflow Graph puts its tables in "_workflows". This option names a different schema.
    schema: process.env.DATABASE_SCHEMA,
    migrations: { runOnStartup: true },
  }),
  encryption: { key: process.env.INTEGRATION_ENCRYPTION_KEY },
  auth: (request) => hasValidSession(request),
  client: clientBundle,
  inngest: {
    id: "my-wfgraph-app",
    baseUrl: process.env.INNGEST_BASE_URL,
    eventKey: process.env.INNGEST_EVENT_KEY,
    signingKey: process.env.INNGEST_SIGNING_KEY,
    // Long-running Node dials out over Connect; serverless hosts omit this
    // and keep `/api/inngest` for Inngest to call back.
    connect: true,
  },
  // The full extension surface, in one location.
  extensions: {
    events: [appointmentCreated],
    actions: [cancelAppointment],
    integrations: builtInIntegrations,
  },
});

// wfgraph.fetch answers the API on /api/*. This call passes a client, so wfgraph.fetch
// answers the editor on /* too.
createServer(createRequestListener(wfgraph)).listen(3000);
```

`examples/app.ts` is the same call with four Events and one custom action. That file is
correct. If this file disagrees with it, this file is wrong.

## Mounting on Node

A fetch-native Node runtime takes `wfgraph.fetch` as it is:

```ts
Bun.serve({ port: 3000, fetch: wfgraph.fetch });
```

Express and Fastify speak `IncomingMessage` and `ServerResponse`.
`createRequestListener` does that translation. It needs Node 20 or later.

```ts
const app = express();
// Mount Workflow Graph before each body parser. Pass the same path as basePath.
app.use("/workflows", createRequestListener(wfgraph));
app.use(express.json());
```

```ts
const app = Fastify();
await app.register(middie); // @fastify/middie, which runs in the onRequest hook
app.use("/workflows", createRequestListener(wfgraph));
```

Two failures the adapter handles for you:

- Express strips the matched path from `req.url`, so the adapter reads `req.originalUrl`.
  It logs once when the mount path and `basePath` disagree.
- A body parser in front of Workflow Graph drains the request. Workflow Graph cannot rebuild the original
  bytes that the Inngest callback verifies a signature over. Such a request gets a 500 that
  names the fix.

## The editor

Pass the bundle and the editor turns on:

```ts
import { clientBundle } from "@wfgraph/client";

const wfgraph = await createWfGraphApp({ client: clientBundle, ... });
```

- Omit `client` and Workflow Graph answers 404 outside `/api`. That suits a host that puts the editor
  elsewhere, or drives workflows with Events alone.
- The option takes a directory that holds an `index.html`, so a custom build of the editor
  is the same call with a different bundle.
- Each of the two packages is independent of the other.

## Built-in integrations

The third-party SDKs stay in `@wfgraph/plugins`. Pass them and they turn on:

```ts
import { builtInIntegrations } from "@wfgraph/plugins";

const wfgraph = await createWfGraphApp({
  // ...
  extensions: { integrations: builtInIntegrations },
});
```

- Each integration is exported by name too, for a host that lists some of the five.
- The editor shows what the server assembled. The action selector lists exactly the
  integrations you passed, and a connection can be stored for those alone.
- That list controls what reaches `createWfGraphApp`. The process still loads every SDK the
  package imports: two of the five carry one, and `@wfgraph/plugins` imports all five as
  values. The static import buys the timing of a failure. A missing SDK stops the
  application at start-up, where a lazy import would let a single run fail much later.
- `@wfgraph/plugins` peer-depends on `@wfgraph/core`. Keep one core copy so the
  plugin definitions and the app share one runtime contract.

## Persistence

`createWfGraphApp` takes one opaque `persistence` value. The backend owns its
connection lifecycle, schema, migrations, queries, and transaction semantics.

For PostgreSQL 15 or newer, pass `wfPostgres`:

Pass a `url`, or pass the separate fields. Use one form only. A mixed value fails to
compile, and Workflow Graph refuses the same mixture at runtime.

```ts
persistence: wfPostgres({
  host: "db.internal",
  port: 5432,
  user: "wfgraph",
  password: process.env.PGPASSWORD!,
  database: "app",
  schema: "_workflows",
  maxConnections: 10,
  ssl: "require",
  migrations: { runOnStartup: false },
}),
```

The separate fields reach postgres.js as fields, so a database name with a space, an IPv6
host, a unix-socket host, and `ssl` all work.

**`schema`** names the Postgres schema that holds Workflow Graph. The default is
`_workflows`. Workflow Graph declares the tables unqualified, and the `search_path` of the connection
puts them in place, so the schema name is a runtime option. Drop that one schema and Workflow Graph
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

For native Node SQLite:

```ts
import { wfSqlite } from "@wfgraph/core/sqlite";

const wfgraph = await createWfGraphApp({
  persistence: wfSqlite({ filename: "./wfgraph.db" }),
  // auth, encryption, inngest, extensions
});
```

`wfSqlite()` with no options uses an in-memory database. Its workflows, runs,
keys, and integrations disappear when the app is disposed or the process exits.
Pass `filename` when the data must survive a restart:

```ts
persistence: wfSqlite(); // ephemeral
persistence: wfSqlite({ filename: "./wfgraph.db" }); // persistent
```

SQLite creates and migrates its own normalized tables when it opens. Every write
takes `BEGIN IMMEDIATE`, so concurrency decisions and wait claims remain atomic
across processes sharing the file. It is the embedded option; PostgreSQL remains
the option for horizontally scaled hosts.

## Cloudflare Workers and Hyperdrive

Workers use the dedicated entry, not the Node app entry:

```ts
import { wfHyperdrive, wfWorker } from "@wfgraph/core/worker";

type Env = {
  HYPERDRIVE: { connectionString: string };
  INTEGRATION_ENCRYPTION_KEY: string;
  INNGEST_SIGNING_KEY: string;
};

export default wfWorker<Env>({
  request: (env) => ({
    auth: (request) => hasValidSession(request),
    persistence: wfHyperdrive(env.HYPERDRIVE),
    encryption: { key: env.INTEGRATION_ENCRYPTION_KEY },
    inngest: {
      id: "my-wfgraph-worker",
      signingKey: env.INNGEST_SIGNING_KEY,
    },
  }),
  extensions: { events, actions, integrations },
});
```

The Worker opens and closes the PostgreSQL client inside each request. Configure
the Hyperdrive binding with query caching disabled: Hyperdrive does not
invalidate cached reads after Workflow Graph writes. Set the PostgreSQL origin
role's default `search_path` to put `_workflows` first (or the `schema` passed to
the factory); startup checks `current_schema()` and refuses a mismatch. Apply
PostgreSQL migrations outside the Worker with `@wfgraph/core/migrate`. Enable
Cloudflare's `nodejs_compat` compatibility flag; the runtime uses Node crypto
and the PostgreSQL driver relies on the Node compatibility APIs.

## PostgreSQL migrations

Two entry points, one migrator.

**At start-up.** `wfPostgres({ migrations })` applies the pending
migrations before the HTTP server starts when `runOnStartup` is true (default
`false`). `migrationsDir` names a different source, resolved from the working directory. The default is the `drizzle/`
directory that `@wfgraph/core` ships, found relative to the running code. Workflow Graph reads the
working directory for that one option, so your own `./drizzle` is safe.

**From CI or a release step**, before an instance boots:

```ts
import { migrateWfGraphDatabase } from "@wfgraph/core/migrate";

await migrateWfGraphDatabase({
  url: process.env.DATABASE_URL!,
  // Or the separate fields. Add `schema` when Workflow Graph lives elsewhere.
  // `migrationsDir` sits here, flat, and takes no `migrations` key.
});
```

- It takes the same connection fields as `wfPostgres`, and it closes the
  connection on the way out, so a one-shot process exits when the promise resolves.
- Run it from several places at once. It holds a session-scoped advisory lock, and each
  caller that waits wakes to an already-migrated database.
- Call it inside a process that already built an application. The connection belongs to the
  call and is closed with it.

**Why this entry point alone applies the shipped SQL.** The files are schema-agnostic, and
`search_path` that selects the schema rides on the connection that Workflow Graph opens. `psql` or a
different migration tool puts the tables in `public`. This repository's
`pnpm run db:migrate` is the same entry with the environment read in front
(`scripts/migrate.ts`).

## Package exports

| Entry                    | What it is                                                                                                                                                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@wfgraph/core`          | The one host-facing entry. `defineEvent` and `defineAction` author the vocabulary. `createWfGraphApp` builds the application, with `WfGraphAppOptions`, `WfGraphApp` and the config types. `createRequestListener` mounts it on Express, Fastify or `node:http`. |
| `@wfgraph/core/postgres` | `wfPostgres` for a Node PostgreSQL pool                                                                                                                                                                                                                          |
| `@wfgraph/core/sqlite`   | `wfSqlite` for native Node SQLite                                                                                                                                                                                                                                |
| `@wfgraph/core/worker`   | `wfWorker`, `wfHyperdrive`, and request-scoped PostgreSQL through Hyperdrive                                                                                                                                                                                     |
| `@wfgraph/core/plugin`   | What an integration package builds against                                                                                                                                                                                                                       |
| `@wfgraph/core/testing`  | `runAction`, `actionData` and `actionError`, for that package's own suite                                                                                                                                                                                        |
| `@wfgraph/core/migrate`  | `migrateWfGraphDatabase`, for migrations without an application                                                                                                                                                                                                  |
| `@wfgraph/core/logging`  | `configureWfGraphLogging`, the console setup a host installs                                                                                                                                                                                                     |
| `@wfgraph/client`        | `clientBundle`, the built editor, passed to `createWfGraphApp` as `client`                                                                                                                                                                                       |
| `@wfgraph/plugins`       | The built-in integrations as values, by name and as `builtInIntegrations`                                                                                                                                                                                        |
| `@wfgraph/plugins/ui`    | Their icons and output renderers as one record, imported by the browser alone                                                                                                                                                                                    |

Workflow Graph cannot serialize a React component, so that last record is the one part of the catalog
that stays off `/api/extensions`. `@wfgraph/shared` stays private, and the build inlines it
into whichever bundle needs it.

`createWfGraphApp` is the Node host. `wfWorker` is the Cloudflare
Worker host and serves the API while the platform's Assets binding or the
application's router serves static files.

## createWfGraphApp options

| Option                    | Required | Description                                                                                                                                                    |
| ------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `basePath`                | No       | Path the host mounts Workflow Graph at (default `/`)                                                                                                           |
| `auth`                    | Yes      | Predicate that decides who reaches the editor, or `"external"`                                                                                                 |
| `persistence`             | Yes      | A backend from `@wfgraph/core/postgres` or `@wfgraph/core/sqlite`                                                                                              |
| `encryption.key`          | Yes      | 64-character hex string. It encrypts the integration secrets                                                                                                   |
| `inngest.id`              | Yes      | Inngest application ID                                                                                                                                         |
| `inngest.*`               | No       | isDev, baseUrl, eventKey, env, signingKey, signingKeyFallback, serveOrigin, servePath, connect, instanceId, gatewayUrl, maxWorkerConcurrency, connectTimeoutMs |
| `extensions.events`       | No       | `defineEvent` values                                                                                                                                           |
| `extensions.actions`      | No       | `defineAction` values                                                                                                                                          |
| `extensions.integrations` | No       | `defineIntegration` values                                                                                                                                     |
| `logger`                  | No       | A `WfGraphLogger` that takes every record. See Logging below                                                                                                   |
| `client`                  | No       | The editor bundle to serve, from `@wfgraph/client`                                                                                                             |

Read these once:

- **`auth` decides who reaches the editor**, and Workflow Graph refuses to start without it. It
  prevents the quiet failure: an editor the internet reaches, running actions with
  credentials decrypted out of the `integrations` table. Pass a predicate
  `(request: Request) => boolean | Promise<boolean>` that reads the session your application
  already uses, or `"external"` when something in front of Workflow Graph already gates it. It covers
  the RPC, REST, OpenAPI, extensions, and SPA routes.
- **Two routes can sit outside that gate:** the wait resume path always, and the
  Inngest HTTP callback only when `inngest.connect` is unset. Their callers are
  machines, each carrying a signing key or a resume token. Workflow Graph alone knows which
  of its routes are which, which is why it takes the predicate as an option and
  applies it route by route. Connect mode mounts no `/api/inngest` — the worker
  dials out — so a private network that Inngest cannot call into still runs.
- **Set `inngest.signingKey` on each cloud deployment.** With HTTP serve,
  `/api/inngest` sits outside the gate because Inngest signs its callbacks, and
  that holds with a configured signing key alone. Without one the SDK runs in
  dev mode and skips the signature check, so an anonymous POST to that path can
  execute a workflow function with a payload of its choice. With Connect, the
  same key authenticates the worker to the gateway. Workflow Graph logs an error at
  start-up when no key is set for the path in use.
- **A mount under a sub-path takes `basePath`.** Workflow Graph builds its API prefix, the
  `<base href>` of the SPA, and each asset URL from it. A host that mounts at `/workflows`
  and omits it gets a client that requests its assets from the root.
- **Running Inngest is the job of the consumer**, self-hosted or cloud. `pnpm run dev` here
  starts it as a separate process. Long-running hosts set `inngest.connect: true` so
  executions arrive over a Connect WebSocket and `/api/inngest` is not mounted.
  Local `pnpm run dev` sets `INNGEST_CONNECT_GATEWAY_URL=ws://localhost:8390/v0/connect`
  because the CLI's Connect gateway listens on 8390. Pass `inngest.instanceId`,
  `inngest.gatewayUrl`, or `inngest.maxWorkerConcurrency` when the worker needs
  them; the SDK also reads `INNGEST_CONNECT_GATEWAY_URL`. Serverless hosts leave
  `connect` unset so Inngest can call `/api/inngest`.
- **`createWfGraphApp` bounds the Connect handshake at boot.** The installed SDK
  retries a failed handshake forever and never settles the promise it hands
  back, so an unreachable gateway would otherwise hang boot with nothing
  logged. Workflow Graph races it against `inngest.connectTimeoutMs` (default 30
  seconds) and fails boot with an error naming the gateway once that elapses.
- `createWfGraphApp` answers `{ fetch, basePath, dispose }`. `await dispose()` drains an
  open Connect worker, then returns when the layers of the Effect runtime finalize. One
  Workflow Graph per process remains the supported arrangement; each app owns its
  persistence instance, Inngest client, encryption key, and assembled surface.

## Logging

Workflow Graph logs through [LogTape](https://logtape.org) and configures none of it.
Every record it writes is under the `wfgraph` category, and where those records go is
the application's decision. A host that installs nothing gets silence, and
`createWfGraphApp` says so once at start-up.

Three ways to receive the records, in the order most hosts want them:

```ts
// 1. The console setup Workflow Graph ships. One call, before createWfGraphApp.
import { configureWfGraphLogging } from "@wfgraph/core/logging";

configureWfGraphLogging();
```

`LOG_LEVEL` names the level (default `info`), `LOG_FORMAT` picks `pretty` or `json`, and
with neither set an attached terminal gets `pretty` while a pipe gets one JSON object per
line. `LOG_PRETTY_PROPERTIES=off` drops the structured fields from the pretty layout, and
`LOG_PRETTY_INSPECT_DEPTH` sets how deep it walks one (default 3). The call takes `level`
and `format` as options for a host that would rather say so in code.

```ts
// 2. An application logger of your own, as one option.
const wfgraph = await createWfGraphApp({ logger: myLogger, ... });
```

A `WfGraphLogger` is any object with `info`, `warn`, `error` and an optional `debug`, each
taking a message and a field bag. Passing one installs a LogTape configuration and
replaces any other in the process, so a host with its own LogTape setup uses the third way
instead.

```ts
// 3. Your own LogTape configuration, with a sink for the wfgraph category.
await configure({
  sinks: { console: getConsoleSink() },
  loggers: [{ category: "wfgraph", sinks: ["console"], lowestLevel: "info" }],
});
```

`@wfgraph/core/migrate` writes through the same category, so a migration job that wants
its output calls one of the three first.

**A record is one unit of work.** One HTTP request writes one record naming the method,
the path, the status, the elapsed time, the RPC procedure it addressed and, when it was
refused, the reason. One node execution writes one record naming the node, what it ran,
how it ended and how long it took. A run writes one when it starts and one when it ends.
No payload is logged: a request body, a response body and an Event payload are all stored
where they can be read whole, and printing them buries the line beside them.

**Fields are grouped.** A record's fields arrive as objects by subject (`http`, `rpc`,
`run`, `node`, `outcome`, `error`) rather than flat. The pretty layout prints one line per
group. The JSON line puts each group at the top level of the object, so a log store
addresses `run.execution` and `http.status`.

## Tracing

Workflow Graph opens OpenTelemetry spans and starts no SDK, no exporter and no processor.
Each service call and each engine step opens its span on Effect's tracer, which is bridged
onto whichever provider `@opentelemetry/api` answers with. That provider is resolved once
per span, so a host may register before or after `createWfGraphApp`, and a host that
registers nothing gets no-op spans.

Five names arrive, all under the `wfgraph-workflows` instrumentation scope:

| Span                              | Opened for                        | Attributes                                                                                           |
| --------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `wfgraph.workflow.execution`      | one run                           | `wfgraph.workflow.id`, `wfgraph.workflow.name`, `wfgraph.execution.id`, `wfgraph.execution.run_mode` |
| `wfgraph.workflow.branch`         | one branch run released by a Wait | the same, plus `wfgraph.branch.entry_node_id`                                                        |
| `wfgraph.workflow.node.execute`   | each node                         | `wfgraph.node.id`, `wfgraph.node.name`, `wfgraph.node.type`, and `wfgraph.action.type` on an action  |
| `wfgraph.workflow.action.execute` | the action inside a node          | `wfgraph.action.type`, `wfgraph.node.id`, `wfgraph.node.name`                                        |
| `wfgraph.workflow.wait`           | a Wait node                       | `wfgraph.wait.type` (`delay` or `event`), `wfgraph.node.id`, `wfgraph.node.name`                     |

**A Wait ends the trace.** Inngest parks the invocation and wakes a separate one, and
nothing carries the trace context across that boundary, so each branch run opens a root
span of its own.

### Sentry

`@sentry/node` puts its own tracer provider on the global OpenTelemetry API, which is the
one Workflow Graph's spans open on. Initialising Sentry is the whole of the trace setup:

```ts
import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 1,
  enableLogs: true,
});
```

Records reach the same trace through `@logtape/sentry`, which reads the trace and span ids
off whichever span is open when a record is written. Sentry's trace view then shows a run's
spans with each record on the node that wrote it.

```ts
import { configure } from "@logtape/logtape";
import { getSentrySink } from "@logtape/sentry";

await configure({
  sinks: { sentry: getSentrySink() },
  loggers: [{ category: "wfgraph", sinks: ["sentry"], lowestLevel: "info" }],
});
```

That is the third way from the section above rather than `configureWfGraphLogging`, because
one LogTape configuration owns the process. Name a console sink beside it to keep reading
the records locally.

### Any other backend

Register a provider on the global API and the spans follow it:

```ts
import {
  BatchSpanProcessor,
  NodeTracerProvider,
} from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

new NodeTracerProvider({
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
}).register();
```

`OTEL_EXPORTER_OTLP_ENDPOINT` names the collector. Workflow Graph's own `Resource` supplies
`service.name` and `service.version` for the instrumentation scope alone; what describes the
service is the `Resource` the host gave its provider.

## API endpoints

The base path is `/api`, under whatever `basePath` names. Workflow Graph builds the full route list
from `packages/shared/src/rpc/contracts.ts` and serves it live:

- `GET /api/openapi.json` for the document
- `GET /api/docs` for the browsable form
