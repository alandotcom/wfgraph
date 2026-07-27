# Rova Workflow Builder

A visual workflow automation platform with a node-based editor, typed API routes, and plugin-driven integrations. Inspired by [Vercel's AI Workflow Builder](https://workflow-builder.dev/).

## Runtime Overview

The backend is a Hono API that runs on any JavaScript runtime (Node.js, Bun, Deno). Local development uses Bun as the dev server. The frontend is a standalone React SPA.

- API: Hono (`packages/core/src/backend/api-app.ts`)
- Database: PostgreSQL via postgres.js + Drizzle ORM
- Async execution/events: Inngest
- Frontend: React SPA + TanStack Router (`packages/client/src/main.tsx`, `packages/client/src/router.tsx`)
- State: Jotai
- Data fetching/cache: TanStack Query
- Dev server: Bun (`server.ts`)

## Project Structure

This is a Bun workspace monorepo with four packages:

```
packages/
  shared/    @rova/shared   Runtime-agnostic types, schemas, registries
  core/      @rova/core     Library entrypoints and backend
  client/    @rova/client   The workflow editor SPA
  plugins/   @rova/plugins  Integration plugins (Acuity, Clerk, Linear, Resend, Slack, Twilio)
```

- `server.ts` -- root dev server entrypoint (imports plugins, starts server)
- `scripts/` -- build and compile scripts

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

- Bun 1.3+
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
INNGEST_DEV=http://localhost:8388
INNGEST_BASE_URL=http://localhost:8288
RUN_DB_MIGRATIONS=false
MIGRATIONS_DIR=drizzle
```

Integration-specific credentials can be provided via the integrations UI and/or environment variables, depending on plugin.

## Database Migrations At Startup

The server can run Drizzle migrations automatically during startup.

- Controlled by `RUN_DB_MIGRATIONS` (default `false`)
- Migration folder is `MIGRATIONS_DIR` (default `drizzle`)
- Startup migrations run before the HTTP server starts (`server.ts`)

Examples:

```bash
# Run migrations at app startup
RUN_DB_MIGRATIONS=true bun run dev:app

# Use a custom migration directory
RUN_DB_MIGRATIONS=true MIGRATIONS_DIR=drizzle bun run dev:app
```

## Local Development

```bash
# Install dependencies
bun install

# Optional: start local Postgres
docker compose up -d

# Apply schema
bun run db:push

# Start app + inngest dev process
bun run dev
```

App URL: `http://localhost:4017`

## Embedding

Rova Workflow Builder mounts into a host app as a single fetch handler. Import `@rova/core/app` for the `createRovaApp` factory, and `@rova/core` for the `createAction`/`createTrigger` helpers. The handler has the shape `(request: Request) => Promise<Response>`, so Bun, Deno, Cloudflare Workers, and Node 18+ consume it directly.

```ts
import { z } from "zod";
import { clientBundle } from "@rova/client";
import { createAction, createTrigger } from "@rova/core";
import { createRovaApp } from "@rova/core/app";

const action = createAction({
  id: "custom/send-message",
  label: "Send Message",
  description: "Sends a custom message",
  category: "Custom",
  logoUrl: "https://cdn.example.com/logos/custom-action.svg",
  // The config form is derived from this schema; `.describe()` names each field.
  schema: z.object({
    text: z.string().trim().min(1).describe("Text"),
  }),
  async execute({ payload }) {
    return { success: true, data: { echoed: payload.text } };
  },
});

const trigger = createTrigger({
  type: "CustomWebhook",
  label: "Custom Webhook",
  description: "Routes custom webhook events",
  logoUrl: "https://cdn.example.com/logos/custom-trigger.svg",
  schema: z.object({
    event: z.enum(["entity.created", "entity.updated", "entity.deleted"]),
    entity: z.object({ id: z.string() }),
  }),
  correlationIdPath: "entity.id",
  lifecycle: {
    onStart: ({ payload }) => payload.event === "entity.created",
    onRestart: ({ payload }) => payload.event === "entity.updated",
    onStop: ({ payload }) => payload.event === "entity.deleted",
  },
});

const rova = await createRovaApp({
  database: { url: process.env.DATABASE_URL! },
  encryption: { key: process.env.INTEGRATION_ENCRYPTION_KEY! },
  auth: (request) => hasValidSession(request),
  client: clientBundle,
  migrations: { runOnStartup: true },
  inngest: {
    client: {
      id: "my-rova-app",
      baseUrl: process.env.INNGEST_BASE_URL,
      eventKey: process.env.INNGEST_EVENT_KEY,
    },
    serve: {
      signingKey: process.env.INNGEST_SIGNING_KEY,
    },
  },
  actions: [action],
  triggers: [trigger],
});

// rova.fetch answers the API under /api/* and, since a client was handed over,
// the editor under /*
Bun.serve({ port: 3000, fetch: rova.fetch });
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

`server.ts` in this repo does exactly that. **`@rova/plugins` is not published yet**: its sources reach into `@rova/core` internals through path aliases that only exist in this workspace, so making it installable means first giving `@rova/core` a public plugin-authoring surface. Until then an outside adopter runs on their own `createAction` definitions.

The editor bundled into `@rova/core` is built from this repo, so it still lists all six built-ins in its palette. On a server that has not registered them, creating one of those connections is refused with a message saying so rather than storing credentials the process cannot use.

### Package exports

- `@rova/core` -- `createAction`, `createTrigger`, and related types.
- `@rova/core/app` -- `createRovaApp` factory, `RovaAppOptions`, `RovaApp`, and re-exported config types.
- `@rova/core/node` -- `createRequestListener`, for hosts on Express, Fastify, or `node:http`.
- `@rova/client` -- `clientBundle`, the built editor, passed to `createRovaApp` as `client`.

The first two run on any runtime with `Request` and `Response`. There is no published server wrapper: once `createRovaApp` returns a fetch handler, a wrapper saves a consumer two lines and charges an options type that reaccumulates every `Bun.serve` parameter. This repo's own dev server lives at `server.ts` in the repo root, and `examples/library-trigger.ts` shows the same shape.

### Linking for development

To use `@rova/core` from another project during development:

```bash
# Register the package (once, from this repo)
cd packages/core && bun link

# Link it in the consumer project
cd /path/to/consumer && bun link @rova/core
```

A linked consumer resolves through the `"exports"` map to `packages/core/dist`, so build the package before linking it and rebuild after changing it.

### createRovaApp options

| Option                     | Required | Description                                                |
| -------------------------- | -------- | ---------------------------------------------------------- |
| `basePath`                 | No       | Path the host mounted Rova at (default `/`)                |
| `database.url`             | Yes      | PostgreSQL connection string                               |
| `encryption.key`           | Yes      | 64-character hex string; encrypts integration secrets      |
| `auth`                     | Yes      | Predicate deciding who reaches the editor, or `"external"` |
| `inngest.client.id`        | Yes      | Inngest application ID                                     |
| `inngest.client.*`         | No       | Inngest client config (baseUrl, eventKey, env, isDev)      |
| `inngest.serve`            | No       | Inngest serve config (signingKey, etc.)                    |
| `migrations.runOnStartup`  | No       | Run Drizzle migrations at startup (default `false`)        |
| `migrations.migrationsDir` | No       | Custom migrations directory                                |
| `logger`                   | No       | Custom logger conforming to `RovaLogger` interface         |
| `configureLogging`         | No       | Enable built-in structured logging (default `true`)        |
| `triggers`                 | No       | Array of custom trigger definitions                        |
| `actions`                  | No       | Array of custom action definitions                         |
| `client`                   | No       | The editor bundle to serve, from `@rova/client`            |

### Notes

- The consumer is responsible for running Inngest (either self-hosted or cloud). Rova does not spawn `inngest-cli`.
- For local development in this repo, `bun run dev` starts Inngest CLI as a separate process.
- `createRovaApp` returns `{ fetch, dispose }`. Call `dispose()` to unregister runtime triggers/actions.
- `auth` decides who reaches the editor. Rova refuses to start in production without it, because the failure it prevents is the quiet one: an editor reachable from the internet, running registered actions with credentials decrypted out of the `integrations` table.
  - Pass a predicate `(request: Request) => boolean | Promise<boolean>` reading whatever session your app already uses. It covers the RPC, REST, OpenAPI, extensions, and SPA routes.
  - The Inngest callback and the webhook and resume paths are deliberately left out. Those callers are machines carrying a signing key, an API key, or a hook token, and a session check would break all three. Which of Rova's routes are which is Rova's knowledge, which is why the predicate is an option rather than middleware you wrap the mount in.
  - Pass `"external"` when something in front of Rova already gates it.
- **Set `inngest.serve.signingKey` on any deployment.** `/api/inngest` sits outside the `auth` gate because Inngest signs its callbacks, and that holds only with a signing key configured. Without one the Inngest SDK runs in dev mode and skips signature verification, so an anonymous POST to that path can execute a workflow function with a payload of its choosing. Rova logs an error at startup when no key is set.
- Mounting under a sub-path means passing `basePath`. Rova builds its API prefix, the SPA's `<base href>`, and every asset URL from it, so the host states the mount point once rather than Rova deducing it per request. A host that mounts at `/workflows` and omits `basePath` gets a client that requests its assets from the root.
- `rova.fetch` answers API routes under `/api/*` and serves the SPA under `/*`. Hand it straight to `Bun.serve`, `Deno.serve`, or a Workers `export default`.
- Action extensions are strict-schema actions via `createAction(...)`:
  - `schema` validates resolved action input at runtime (Zod or Standard Schema-compatible validators).
  - `execute({ payload, context })` receives typed payload validated by `schema`.
  - `id`, `label`, `description`, `category`, `logoUrl`, `configFields`, and `outputFields` define action metadata.
- Trigger extensions are strict-schema triggers via `createTrigger(...)`:
  - `type` is the stable trigger ID and must be unique.
  - `schema` validates inbound payloads at runtime (Zod or Standard Schema-compatible validators).
  - `correlationIdPath` is required and typed from the payload schema (`string` fields only).
  - `lifecycle.onStart`, `lifecycle.onRestart`, and `lifecycle.onStop` define routing using typed payload callbacks.
  - `label`, `description`, `logoUrl`, and `configFields` control editor metadata.
- `logoUrl` is optional; when provided, it is rendered in trigger/action selectors.

## Compile Standalone Binary

Build a standalone executable:

```bash
bun run compile
```

Output binary:

- `dist/server`

Run it:

```bash
PORT=4017 DATABASE_URL=postgresql://workflow:workflow@localhost:55437/workflow_builder INTEGRATION_ENCRYPTION_KEY=$INTEGRATION_ENCRYPTION_KEY ./dist/server
```

Run it with startup migrations:

```bash
RUN_DB_MIGRATIONS=true PORT=4017 DATABASE_URL=postgresql://workflow:workflow@localhost:55437/workflow_builder INTEGRATION_ENCRYPTION_KEY=$INTEGRATION_ENCRYPTION_KEY ./dist/server
```

## Docker Build And Run

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

- `bun run dev` - run app, client watcher, and inngest dev processes
- `bun run dev:app` - run only Bun app server
- `bun run dev:client` - run client build in watch mode
- `bun run dev:inngest` - run only inngest dev process
- `bun run build` - build library + client + copy migrations
- `bun run build:lib` - build library artifacts (`packages/core/dist/`)
- `bun run build:client` - build client SPA (`packages/core/dist/client/`)
- `bun run compile` - build standalone executable to `dist/server`
- `bun run start` - run standalone compiled server (`./dist/server`)
- `bun run test` - run tests
- `bun run type-check` - run TypeScript checks
- `bun run check` - lint/format check
- `bun run fix` - lint/format auto-fix
- `bun run db:generate` - generate drizzle migration
- `bun run db:migrate` - apply generated migration
- `bun run db:push` - push schema directly
- `bun run db:studio` - open Drizzle Studio

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

Use the typed client from `packages/client/src/lib/rpc-client.ts`:

```ts
import { api } from "@/lib/rpc-client";
```

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
bun run type-check
bun run fix
bun run test
```

## Roadmap

- [ ] Authentication (user login, session management, role-based access)
