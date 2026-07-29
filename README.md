# Rova Workflow Builder

A visual workflow automation platform with a node-based editor, typed API routes, and plugin-driven integrations. Inspired by [Vercel's AI Workflow Builder](https://workflow-builder.dev/).

## Runtime Overview

The backend is a Hono API that runs on any JavaScript runtime with `Request` and `Response`. This repo develops and deploys on Node 24. The frontend is a standalone React SPA.

- API: Hono (`packages/core/src/backend/api-app.ts`)
- Database: PostgreSQL via postgres.js + Drizzle ORM
- Async execution/events: Inngest
- Frontend: React SPA + TanStack Router (`packages/client/src/main.tsx`, `packages/client/src/router.tsx`)
- State: Jotai
- Data fetching/cache: TanStack Query
- Dev server: Vite in `packages/client`, proxying `/api` to the example app

## Project Structure

This is a pnpm workspace monorepo with four packages:

```
packages/
  shared/    @rova/shared   Runtime-agnostic types, schemas, registries
  core/      @rova/core     Library entrypoints and backend
  client/    @rova/client   The workflow editor SPA
  plugins/   @rova/plugins  Integration plugins (Acuity, Clerk, Linear, Resend, Slack, Twilio)
```

- `examples/app.ts` -- the repo's only server, for development and production. It is an adopter's app: options from the environment, a custom trigger and action, a `node:http` mount. See `docs/adr/0006`.
- `packages/client/vite.config.ts` -- the SPA's dev server and build
- `scripts/` -- standalone scripts and the shared Vite alias module

## Integrations

Supported integration types:

- Acuity
- Clerk
- Database
- Linear
- Resend
- Slack
- Twilio

Plugin definitions and steps are under `packages/plugins/src`.

## Prerequisites

- Node 24+
- pnpm 11+ (the exact version is in the root `package.json`'s `packageManager` field; run `corepack enable` to have Node use it)
- PostgreSQL 15+ (local or remote)
- Docker (optional, for local Postgres via `docker compose`)

## Environment Variables

Create `.env.local` (or `.env`) with at least:

```env
DATABASE_URL=postgresql://workflow:workflow@localhost:55437/workflow_builder
```

Common optional variables:

```env
PORT=4017
HOST=127.0.0.1
INNGEST_BASE_URL=http://localhost:8288
RUN_DB_MIGRATIONS=false
MIGRATIONS_DIR=packages/core/drizzle
```

Integration-specific credentials can be provided via the integrations UI and/or environment variables, depending on plugin.

## Database Migrations At Startup

The server can run Drizzle migrations automatically during startup.

- Controlled by `RUN_DB_MIGRATIONS` (default `false`)
- Migration folder defaults to the `drizzle/` directory `@rova/core` ships, found relative
  to the running code. `MIGRATIONS_DIR` overrides it and is resolved from the working
  directory. Nothing is guessed from the working directory otherwise, so an embedder's own
  `./drizzle` is never mistaken for Rova's.
- Startup migrations run before the HTTP server starts (`examples/app.ts`)

Examples:

```bash
# Run migrations at app startup
RUN_DB_MIGRATIONS=true pnpm run dev

# Use a custom migration directory, resolved from the working directory
RUN_DB_MIGRATIONS=true MIGRATIONS_DIR=packages/core/drizzle pnpm run dev
```

## Local Development

```bash
# Install dependencies
pnpm install

# Optional: start local Postgres
docker compose up -d

# Apply schema
pnpm run db:push

# Start the app, the client dev server, and the inngest dev process
pnpm run dev
```

Editor URL: `http://localhost:5173`. The Vite dev server compiles the SPA and forwards
`/api` to the app, which listens on `http://localhost:4017` and answers the API there.

The webhook URL a trigger panel offers for copying carries the editor's port, so when you
hand it to a sender outside the browser, a tunnel or a third-party service, substitute the
app's port (4017).

## Embedding

Rova Workflow Builder mounts into a host app as a single fetch handler. Import `@rova/core/app` for the `createRovaApp` factory, and `@rova/core` for the `createAction`/`createTrigger` helpers. The handler has the shape `(request: Request) => Promise<Response>`, so Bun, Deno, Cloudflare Workers, and Node 18+ consume it directly.

```ts
import { createServer } from "node:http";
import { Schema } from "effect";
import { clientBundle } from "@rova/client";
import { createAction, createTrigger } from "@rova/core";
import { createRovaApp } from "@rova/core/app";
import { createRequestListener } from "@rova/core/node";

const action = createAction({
  id: "custom/send-message",
  label: "Send Message",
  description: "Sends a custom message",
  category: "Custom",
  logoUrl: "https://cdn.example.com/logos/custom-action.svg",
  // The config form is derived from this schema, and a `description`
  // annotation names each field. Annotate the base type before adding a
  // check: a message on a checked schema lands on the check instead.
  schema: Schema.Struct({
    text: Schema.String.annotate({ description: "Text" }).check(
      Schema.isMinLength(1)
    ),
  }),
  async execute({ payload }) {
    return { success: true, data: { echoed: payload.text } };
  },
});

// A trigger supplies vocabulary, never policy: the schema, where the
// correlation key lives, and where the event type lives. What each event
// type does to a run (Start, Replace, Cancel, Ignore) is the workflow's
// Routing Policy, configured per workflow in the editor's trigger panel.
const trigger = createTrigger({
  type: "CustomWebhook",
  label: "Custom Webhook",
  description: "Classifies custom webhook events",
  logoUrl: "https://cdn.example.com/logos/custom-trigger.svg",
  schema: Schema.Struct({
    event: Schema.Literals([
      "entity.created",
      "entity.updated",
      "entity.deleted",
    ]),
    entity: Schema.Struct({ id: Schema.String }),
  }),
  correlationIdPath: "entity.id",
  eventTypePath: "event",
});

const rova = await createRovaApp({
  database: { url: process.env.DATABASE_URL! },
  encryption: { key: process.env.INTEGRATION_ENCRYPTION_KEY },
  auth: (request) => hasValidSession(request),
  client: clientBundle,
  migrations: { runOnStartup: true },
  inngest: {
    id: "my-rova-app",
    baseUrl: process.env.INNGEST_BASE_URL,
    eventKey: process.env.INNGEST_EVENT_KEY,
    signingKey: process.env.INNGEST_SIGNING_KEY,
  },
  actions: [action],
  triggers: [trigger],
});

// rova.fetch answers the API under /api/* and, since a client was handed over,
// the editor under /*. On Node, createRequestListener translates the fetch
// handler into the IncomingMessage/ServerResponse pair node:http speaks.
createServer(createRequestListener(rova)).listen(3000);
```

### Mounting

`rova.fetch` has the shape `(request: Request) => Promise<Response>`, so a fetch-native runtime takes it directly:

```ts
Bun.serve({ port: 3000, fetch: rova.fetch }); // Bun
Deno.serve({ port: 3000 }, rova.fetch); // Deno
export default { fetch: rova.fetch }; // Cloudflare Workers
```

Express and Fastify sit on Node's `http` module, which speaks `IncomingMessage`/`ServerResponse`. `@rova/core/node` translates between the two. It needs Node 20 or newer.

```ts
import express from "express";
import { createRequestListener } from "@rova/core/node";

const app = express();
// Mount Rova ahead of any body parser, and pass the same path as basePath.
app.use("/workflows", createRequestListener(rova));
app.use(express.json());
```

Fastify reaches connect-style middleware through `@fastify/middie`, which runs it in the `onRequest` hook, before Fastify parses the body:

```ts
import Fastify from "fastify";
import middie from "@fastify/middie";
import { createRequestListener } from "@rova/core/node";

const app = Fastify();
await app.register(middie);
app.use("/workflows", createRequestListener(rova));
```

Two things about a Node mount are worth knowing, and the adapter handles both:

- Express rewrites `req.url` to strip the path it matched on, so a listener mounted at `/workflows` sees `/api/extensions` where the browser asked for `/workflows/api/extensions`. The adapter reads `req.originalUrl`, which is where the full path survives.
- A body parser mounted ahead of Rova drains the request, so every POST would arrive empty. Rova cannot re-create the original bytes, and the Inngest callback verifies a signature over them, so a drained request gets a 500 that names the fix rather than a silent empty body.

### The editor

`@rova/core` serves an API and nothing else. The editor lives in `@rova/client`, and a host that wants it hands it over:

```ts
import { clientBundle } from "@rova/client";

const rova = await createRovaApp({ client: clientBundle, ... });
```

Passing it is the switch. Leave it out and Rova answers 404 outside `/api`, which is what an adopter embedding the editor elsewhere, or driving workflows by webhook alone, wants. Nothing depends on `@rova/client` in either direction: `createRovaApp` takes a directory to serve, so a custom build of the editor is the same call with a different `dir`.

### Built-in integrations

`@rova/core` carries no vendor SDKs. The built-in integrations (Acuity, Clerk, Linear, Resend, Slack, Twilio) live in `@rova/plugins`, which registers them through two side-effect imports:

```ts
import "@rova/plugins"; // integration metadata the editor renders
import "@rova/plugins/server"; // step implementations and connection tests, loaded on demand
```

`examples/app.ts` in this repo does exactly that. `@rova/plugins` peer-depends on `@rova/core`: a second copy would mean a second database handle, which is what one-Rova-per-process exists to prevent.

`@rova/client` lists all six built-ins in its palette regardless. On a server that has not registered them, creating one of those connections is refused rather than storing credentials the process cannot use.

### Writing your own integration package

`@rova/plugins` is built against `@rova/core/plugin` and nothing else, so an outside package can be written the same way. It exports five names: `fetchCredentials`, `registerStepImporter`, `registerIntegrationTest`, `withStepLogging`, and the `StepInput` type.

### Package exports

- `@rova/core` -- `createAction`, `createTrigger`, and related types.
- `@rova/core/app` -- `createRovaApp` factory, `RovaAppOptions`, `RovaApp`, and re-exported config types.
- `@rova/core/node` -- `createRequestListener`, for hosts on Express, Fastify, or `node:http`.
- `@rova/core/plugin` -- what an integration package builds against.
- `@rova/client` -- `clientBundle`, the built editor, passed to `createRovaApp` as `client`.
- `@rova/plugins` -- the built-in integrations, and `@rova/plugins/server` for their step and connection-test registrations.

The first two run on any runtime with `Request` and `Response`. There is no published server wrapper: once `createRovaApp` returns a fetch handler, a wrapper saves a consumer two lines and charges an options type that reaccumulates every parameter the host's own server takes. This repo has no server of its own; `examples/app.ts` is an app written the way an adopter writes one, and running it is how the mount above stays exercised.

### Linking for development

To use `@rova/core` from another project during development:

```bash
# From the consumer project, point at this repo's core package by path.
# pnpm 11 takes a path here; the `--global` form of earlier versions is gone.
cd /path/to/consumer && pnpm link /path/to/rova/packages/core
```

A linked consumer resolves through the `"exports"` map to `packages/core/dist`, so build the package before linking it and rebuild after changing it.

### createRovaApp options

| Option                     | Required | Description                                                |
| -------------------------- | -------- | ---------------------------------------------------------- |
| `basePath`                 | No       | Path the host mounted Rova at (default `/`)                |
| `database.url`             | Yes      | PostgreSQL connection string                               |
| `encryption.key`           | Yes      | 64-character hex string; encrypts integration secrets      |
| `auth`                     | Yes      | Predicate deciding who reaches the editor, or `"external"` |
| `inngest.id`               | Yes      | Inngest application ID                                     |
| `inngest.*`                | No       | baseUrl, eventKey, env, isDev, signingKey, serveOrigin     |
| `migrations.runOnStartup`  | No       | Run Drizzle migrations at startup (default `false`)        |
| `migrations.migrationsDir` | No       | Custom migrations directory                                |
| `logger`                   | No       | Custom logger conforming to `RovaLogger` interface         |
| `configureLogging`         | No       | Enable built-in structured logging (default `true`)        |
| `triggers`                 | No       | Array of custom trigger definitions                        |
| `actions`                  | No       | Array of custom action definitions                         |
| `client`                   | No       | The editor bundle to serve, from `@rova/client`            |

### Notes

- The consumer is responsible for running Inngest (either self-hosted or cloud). Rova does not spawn `inngest-cli`.
- For local development in this repo, `pnpm run dev` starts Inngest CLI as a separate process.
- `createRovaApp` returns `{ fetch, dispose }`. Call `dispose()` to unregister runtime triggers/actions.
- `auth` decides who reaches the editor. Rova refuses to start in production without it, because the failure it prevents is the quiet one: an editor reachable from the internet, running registered actions with credentials decrypted out of the `integrations` table.
  - Pass a predicate `(request: Request) => boolean | Promise<boolean>` reading whatever session your app already uses. It covers the RPC, REST, OpenAPI, extensions, and SPA routes.
  - The Inngest callback and the webhook and resume paths are deliberately left out. Those callers are machines carrying a signing key, an API key, or a hook token, and a session check would break all three. Which of Rova's routes are which is Rova's knowledge, which is why the predicate is an option rather than middleware you wrap the mount in.
  - Pass `"external"` when something in front of Rova already gates it.
- **Set `inngest.signingKey` on any deployment.** `/api/inngest` sits outside the `auth` gate because Inngest signs its callbacks, and that holds only with a signing key configured. Without one the Inngest SDK runs in dev mode and skips signature verification, so an anonymous POST to that path can execute a workflow function with a payload of its choosing. Rova logs an error at startup when no key is set.
- Mounting under a sub-path means passing `basePath`. Rova builds its API prefix, the SPA's `<base href>`, and every asset URL from it, so the host states the mount point once rather than Rova deducing it per request. A host that mounts at `/workflows` and omits `basePath` gets a client that requests its assets from the root.
- `rova.fetch` answers API routes under `/api/*` and serves the SPA under `/*`. Hand it straight to `Bun.serve`, `Deno.serve`, or a Workers `export default`; on Node, pass it through `createRequestListener` from `@rova/core/node` first.
- Action extensions are strict-schema actions via `createAction(...)`:
  - `schema` validates resolved action input at runtime. Write it in Effect Schema, Zod, or arktype and pass it as it is — `createAction` takes each in the form its library produces.
  - `execute({ payload, context })` receives typed payload validated by `schema`.
  - `id`, `label`, `description`, `category`, `logoUrl`, `configFields`, and `outputFields` define action metadata.
- Trigger extensions are strict-schema triggers via `createTrigger(...)`:
  - `type` is the stable trigger ID and must be unique.
  - `schema` validates inbound payloads at runtime, in whichever library you wrote it. A payload that fails is ignored as `invalid_payload`.
  - `correlationIdPath` is required and typed from the payload schema (`string` fields only). Runs sharing its value belong to the same entity: Replace and Cancel act on them, and Waits resume on them.
  - `eventTypePath` names where the event type lives in the payload. Pointing it at an enum gives the editor a closed list for the Routing Policy table and Wait node options. Required in webhook mode; optional in event mode, where omitting it makes the delivering Inngest event name the event type.
  - Routing lives in the workflow, not the trigger: each workflow maps event types to Start, Replace, Cancel, or Ignore in the editor. Unmapped event types are ignored, though they still resume matching Waits.
  - Event mode: set `event` to one or more Inngest event names to listen for `inngest.send(...)` instead of webhook calls; this also enables `concurrency` and the `inngest` options block (rateLimit, throttle, debounce, CEL `priority.run`, timeouts, retries), with all dot-path keys schema-relative and auto-prefixed with `event.data.`.
  - `label`, `description`, `logoUrl`, and `configFields` control editor metadata.
- `logoUrl` is optional; when provided, it is rendered in trigger/action selectors.

## Run In Production

Build every package, then start the same `examples/app.ts` the dev loop runs. `NODE_ENV=production` is what makes it hand the built client to `createRovaApp`, so one process serves the editor, its assets, and the API. There is no Vite dev server in this mode.

```bash
pnpm run build
pnpm run start
```

Point it at a database and give it an encryption key:

```bash
PORT=4017 DATABASE_URL=postgresql://workflow:workflow@localhost:55437/workflow_builder INTEGRATION_ENCRYPTION_KEY=$INTEGRATION_ENCRYPTION_KEY pnpm run start
```

Run it with startup migrations:

```bash
RUN_DB_MIGRATIONS=true PORT=4017 DATABASE_URL=postgresql://workflow:workflow@localhost:55437/workflow_builder INTEGRATION_ENCRYPTION_KEY=$INTEGRATION_ENCRYPTION_KEY pnpm run start
```

## Docker Build And Run

The `Dockerfile` is out of date: it still targets Bun and a single-package `src/` layout, so `docker build` fails. Tracked in [#5](https://github.com/alandotcom/rova/issues/5). Use the `pnpm run build && pnpm run start` path above until it is rebuilt.

Build image:

```bash
docker build -t rova-workflow-builder .
```

Run container:

```bash
docker run --rm \
  -p 4017:4017 \
  -e DATABASE_URL=postgresql://workflow:workflow@host.docker.internal:55437/workflow_builder \
  -e RUN_DB_MIGRATIONS=true \
  rova-workflow-builder
```

## Scripts

- `pnpm run dev` - run the app, the client dev server, and the inngest dev process together
- `pnpm run dev:inngest` - run only the inngest dev process
- `pnpm run build` - `pnpm -r build`; each package builds itself, in workspace-graph order
- `pnpm --filter @rova/client dev` - run only the client dev server (Vite, proxying `/api` to port 4017)
- `pnpm --filter @rova/client build` - build `@rova/client` alone: the entry via tsdown, then the SPA via Vite into `packages/client/dist/client/`
- `pnpm run start` - run the app in production mode (`examples/app.ts` with `NODE_ENV=production`)
- `pnpm run test` - run the vitest suite once
- `pnpm run test:watch` - run vitest in watch mode
- `pnpm run type-check` - run TypeScript checks
- `pnpm run lint` - run oxlint with type-aware rules
- `pnpm run knip` - report unused files, exports, and dependencies
- `pnpm run check` - format check (oxfmt --check)
- `pnpm run fix` - format auto-fix (oxfmt)
- `pnpm run db:generate` - generate drizzle migration
- `pnpm run db:migrate` - apply generated migration
- `pnpm run db:push` - push schema directly
- `pnpm run db:studio` - open Drizzle Studio

## API Endpoints

Base path: `/api`

### API Keys

- `GET /api/api-keys`
- `POST /api/api-keys`
- `DELETE /api/api-keys/:keyId`

### Integrations

- `GET /api/integrations`
- `POST /api/integrations`
- `POST /api/integrations/test`
- `GET /api/integrations/:integrationId`
- `PUT /api/integrations/:integrationId`
- `DELETE /api/integrations/:integrationId`
- `POST /api/integrations/:integrationId/test`

### Workflows

- `POST /api/workflow/:workflowId/execute`
- `GET /api/workflows`
- `POST /api/workflows/create`
- `GET /api/workflows/current`
- `POST /api/workflows/current`
- `GET /api/workflows/:workflowId`
- `PATCH /api/workflows/:workflowId`
- `DELETE /api/workflows/:workflowId`
- `POST /api/workflows/:workflowId/duplicate`
- `GET /api/workflows/:workflowId/executions`
- `DELETE /api/workflows/:workflowId/executions`
- `OPTIONS /api/workflows/:workflowId/webhook`
- `POST /api/workflows/:workflowId/webhook`
- `GET /api/workflows/executions/:executionId/status`
- `GET /api/workflows/executions/:executionId/logs`
- `GET /api/workflows/executions/:executionId/events`
- `POST /api/workflows/executions/:executionId/cancel`
- `POST /api/workflows/hooks/:token/resume`

### Inngest

- `GET /api/inngest`
- `POST /api/inngest`
- `PUT /api/inngest`

## Typed Client

Reads and writes in the SPA both go through `orpcQuery`, which wraps the RPC contract for TanStack Query so a query key is derived from the contract path:

```ts
import { orpcQuery } from "#src/lib/rpc-query";
```

`packages/client/src/lib/rpc-client.ts` holds what sits underneath: the raw `rpc` client, `ApiError`, and the `toSavedWorkflow`/`toSavedWorkflows` codecs.

## Database Tables

Defined in `packages/core/src/backend/lib/db/schema.ts`:

- `workflows`
- `integrations`
- `workflow_executions`
- `workflow_execution_logs`
- `workflow_wait_states`
- `workflow_execution_events`
- `api_keys`

## Quality Gates

Before committing:

```bash
pnpm run type-check
pnpm run lint
pnpm run test
pnpm run knip
pnpm run fix
pnpm run build
```

## Roadmap

- [ ] Authentication (user login, session management, role-based access)
