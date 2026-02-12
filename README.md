# AI Workflow Builder Template

A Bun-based workflow automation app with a visual editor, typed API routes, and plugin-driven integrations.

## Runtime Overview

This project runs as a Bun server with a React SPA frontend.

- HTTP server: Bun (`src/backend/server/index.ts`)
- API: Hono (`src/backend/server/hono-app.ts`)
- Frontend: React SPA + TanStack Router (`src/client/main.tsx`, `src/client/router.tsx`)
- State: Jotai
- Data fetching/cache: TanStack Query
- Database: PostgreSQL + Drizzle ORM
- Async execution/events: Inngest

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
```

Integration-specific credentials can be provided via the integrations UI and/or environment variables, depending on plugin.

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

## Scripts

- `bun run dev` - run app and inngest dev processes
- `bun run dev:app` - run only Bun app server
- `bun run dev:inngest` - run only inngest dev process
- `bun run build` - production build to `dist/`
- `bun run start` - run production build
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

Use the typed client from `src/lib/rpc-client.ts`:

```ts
import { api } from "@/lib/rpc-client";
```

## Database Tables

Defined in `src/lib/db/schema.ts`:

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
