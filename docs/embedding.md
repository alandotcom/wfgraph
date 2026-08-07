# Embedding Workflow Graph

How to mount Workflow Graph in a host application: `createWfGraphApp`, the editor, integrations, database, migrations, package exports, and options.

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
  database: {
    url: process.env.DATABASE_URL!,
    // Workflow Graph puts its tables in "_workflows". This option names a different schema.
    schema: process.env.DATABASE_SCHEMA,
    migrations: { runOnStartup: true },
  },
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

## Mounting

A fetch-native runtime takes `wfgraph.fetch` as it is:

```ts
Bun.serve({ port: 3000, fetch: wfgraph.fetch }); // Bun
Deno.serve({ port: 3000 }, wfgraph.fetch); // Deno
export default { fetch: wfgraph.fetch }; // Cloudflare Workers
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

- Each integration is exported by name too, for a host that lists some of the six.
- The editor shows what the server assembled. The action selector lists exactly the
  integrations you passed, and a connection can be stored for those alone.
- That list controls what reaches `createWfGraphApp`. The process still loads every SDK the
  package imports: three of the six carry one, and `@wfgraph/plugins` imports all six as
  values. The static import buys the timing of a failure. A missing SDK stops the
  application at start-up, where a lazy import would let a single run fail much later.
- `@wfgraph/plugins` peer-depends on `@wfgraph/core`. A second copy means a second database
  handle, which the one-instance-per-process rule prevents.

## The database options

Pass a `url`, or pass the separate fields. Use one form only. A mixed value fails to
compile, and Workflow Graph refuses the same mixture at runtime.

```ts
database: {
  host: "db.internal",
  port: 5432,
  user: "wfgraph",
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

**`database.schema`** names the Postgres schema that holds Workflow Graph. The default is
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

## Migrations

Two entry points, one migrator.

**At start-up.** `database.migrations.runOnStartup` (default `false`) applies the pending
migrations before the HTTP server starts. `database.migrations.migrationsDir` names a
different source, resolved from the working directory. The default is the `drizzle/`
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

- It takes the same connection fields as the `database` option, and it closes the
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

| Entry                   | What it is                                                                                                                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@wfgraph/core`         | The one host-facing entry. `defineEvent` and `defineAction` author the vocabulary. `createWfGraphApp` builds the application, with `WfGraphAppOptions`, `WfGraphApp` and the config types. `createRequestListener` mounts it on Express, Fastify or `node:http`. |
| `@wfgraph/core/plugin`  | What an integration package builds against                                                                                                                                                                                                                       |
| `@wfgraph/core/testing` | `runAction`, `actionData` and `actionError`, for that package's own suite                                                                                                                                                                                        |
| `@wfgraph/core/migrate` | `migrateWfGraphDatabase`, for migrations without an application                                                                                                                                                                                                  |
| `@wfgraph/client`       | `clientBundle`, the built editor, passed to `createWfGraphApp` as `client`                                                                                                                                                                                       |
| `@wfgraph/plugins`      | The built-in integrations as values, by name and as `builtInIntegrations`                                                                                                                                                                                        |
| `@wfgraph/plugins/ui`   | Their icons and output renderers as one record, imported by the browser alone                                                                                                                                                                                    |

Workflow Graph cannot serialize a React component, so that last record is the one part of the catalog
that stays off `/api/extensions`. `@wfgraph/shared` stays private, and the build inlines it
into whichever bundle needs it.

Each export except `createRequestListener` runs on a runtime with `Request` and `Response`.
`createWfGraphApp` already answers a fetch handler, so mounting it is two lines the host owns.
A published wrapper would charge an options type that reaccumulates each parameter the
server of the host takes.

## createWfGraphApp options

| Option                              | Required | Description                                                                                                                                                    |
| ----------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `basePath`                          | No       | Path the host mounts Workflow Graph at (default `/`)                                                                                                           |
| `auth`                              | Yes      | Predicate that decides who reaches the editor, or `"external"`                                                                                                 |
| `database.url`                      | Yes¹     | PostgreSQL connection string                                                                                                                                   |
| `database.host` and co.             | Yes¹     | `host`, `port`, `user`, `password`, `database`, in place of a URL                                                                                              |
| `database.schema`                   | No       | Postgres schema Workflow Graph keeps its tables in (default `_workflows`)                                                                                      |
| `database.maxConnections`           | No       | Connections the query pool can open (default 10)                                                                                                               |
| `database.ssl`                      | No       | `true`, `"require"`, `"allow"`, `"prefer"` or `"verify-full"`                                                                                                  |
| `database.migrations.runOnStartup`  | No       | Apply the pending migrations at start-up (default `false`)                                                                                                     |
| `database.migrations.migrationsDir` | No       | Custom migrations directory                                                                                                                                    |
| `encryption.key`                    | Yes      | 64-character hex string. It encrypts the integration secrets                                                                                                   |
| `inngest.id`                        | Yes      | Inngest application ID                                                                                                                                         |
| `inngest.*`                         | No       | isDev, baseUrl, eventKey, env, signingKey, signingKeyFallback, serveOrigin, servePath, connect, instanceId, gatewayUrl, maxWorkerConcurrency, connectTimeoutMs |
| `extensions.events`                 | No       | `defineEvent` values                                                                                                                                           |
| `extensions.actions`                | No       | `defineAction` values                                                                                                                                          |
| `extensions.integrations`           | No       | `defineIntegration` values                                                                                                                                     |
| `logger`                            | No       | A `WfGraphLogger` that takes each log line. The default is a console sink                                                                                      |
| `client`                            | No       | The editor bundle to serve, from `@wfgraph/client`                                                                                                             |

¹ `database` takes one arm of the two. `schema`, `maxConnections`, `ssl` and `migrations`
are valid on both.

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
  Workflow Graph per process is the supported arrangement, because the database handle, the Inngest
  client, the encryption key and the assembled surface are global to the process.

## API endpoints

The base path is `/api`, under whatever `basePath` names. Workflow Graph builds the full route list
from `packages/shared/src/rpc/contracts.ts` and serves it live:

- `GET /api/openapi.json` for the document
- `GET /api/docs` for the browsable form
