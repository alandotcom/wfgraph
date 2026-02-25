# Rova Workflow Builder

A visual workflow automation platform with a node-based editor, typed API routes, and plugin-driven integrations. Inspired by [Vercel's AI Workflow Builder](https://workflow-builder.dev/).

## Runtime Overview

The backend is a Hono API that runs on any JavaScript runtime (Node.js, Bun, Deno). Local development uses Bun as the dev server. The frontend is a standalone React SPA.

- API: Hono (`src/backend/app.ts`)
- Database: PostgreSQL via postgres.js + Drizzle ORM
- Async execution/events: Inngest
- Frontend: React SPA + TanStack Router (`src/client/main.tsx`, `src/client/router.tsx`)
- State: Jotai
- Data fetching/cache: TanStack Query
- Dev server: Bun (`src/server.ts`)

All source code lives under `src/`.

## Integrations

Supported integration types:

- Acuity
- Clerk
- Database
- Linear
- Resend
- Slack
- Twilio

Plugin definitions and steps are under `src/plugins`.

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
- Startup migrations run before the HTTP server starts (`src/server.ts`)

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

Rova Workflow Builder is an embeddable Hono app. Import `rova-workflows/hono` to get a mountable sub-application, and `rova-workflows` for the `createAction`/`createTrigger` helpers. Works on Node.js, Bun, or any runtime that supports Hono.

```ts
import { Hono } from "hono";
import { z } from "zod";
import { createAction, createTrigger } from "rova-workflows";
import { createRovaApp } from "rova-workflows/hono";

const action = createAction({
  id: "custom/send-message",
  label: "Send Message",
  description: "Sends a custom message",
  category: "Custom",
  logoUrl: "https://cdn.example.com/logos/custom-action.svg",
  configFields: [
    { key: "text", label: "Text", type: "template-textarea", required: true },
  ],
  schema: z.object({
    text: z.string().trim().min(1),
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

const app = new Hono();
app.route("/api", rova.app);
// Routes: /api/rpc/..., /api/inngest, /api/extensions, /api/workflows/:id/webhook

export default app;
```

### Package exports

- `rova-workflows` -- `createAction`, `createTrigger`, and related types.
- `rova-workflows/hono` -- `createRovaApp` factory, `RovaAppOptions`, `RovaApp`, and re-exported config types.

### createRovaApp options

| Option | Required | Description |
|--------|----------|-------------|
| `database.url` | Yes | PostgreSQL connection string |
| `inngest.client.id` | Yes | Inngest application ID |
| `inngest.client.*` | No | Inngest client config (baseUrl, eventKey, env, isDev) |
| `inngest.serve` | No | Inngest serve config (signingKey, etc.) |
| `migrations.runOnStartup` | No | Run Drizzle migrations at startup (default `false`) |
| `migrations.migrationsDir` | No | Custom migrations directory |
| `logger` | No | Custom logger conforming to `RovaLogger` interface |
| `configureLogging` | No | Enable built-in structured logging (default `true`) |
| `triggers` | No | Array of custom trigger definitions |
| `actions` | No | Array of custom action definitions |

### Notes

- The consumer is responsible for running Inngest (either self-hosted or cloud). Rova does not spawn `inngest-cli`.
- For local development in this repo, `bun run dev` starts Inngest CLI as a separate process.
- `createRovaApp` returns `{ app, dispose }`. Call `dispose()` to unregister runtime triggers/actions.
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
PORT=4017 DATABASE_URL=postgresql://workflow:workflow@localhost:55437/workflow_builder ./dist/server
```

Run it with startup migrations:

```bash
RUN_DB_MIGRATIONS=true PORT=4017 DATABASE_URL=postgresql://workflow:workflow@localhost:55437/workflow_builder ./dist/server
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

- `bun run dev` - run app and inngest dev processes
- `bun run dev:app` - run only Bun app server
- `bun run dev:inngest` - run only inngest dev process
- `bun run build` - build library artifacts to `dist/lib` (`.mjs` + `.d.mts`)
- `bun run build:lib` - alias for `bun run build`
- `bun run compile` - build standalone executable to `dist/server`
- `bun run start` - run standalone compiled server (`./dist/server`)
- `bun run test` - run Vitest tests
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

Use the typed client from `src/client/lib/rpc-client.ts`:

```ts
import { api } from "@/client/lib/rpc-client";
```

## Database Tables

Defined in `src/backend/lib/db/schema.ts`:

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
