# Agent Instructions

## Package Management

This project uses **Bun** as its package manager.

- Install packages: `bun add <package>`
- Run scripts: `bun run <script-name>`
- Add shadcn/ui components: `bun add -d shadcn@latest` then `bun run shadcn add <component>`

Never use npm or yarn.

## Third-Party Libraries

- Always use tools like Context7 and/or Exa to check official usage patterns before implementing third-party library code.
- Prefer the latest stable package versions by default.
- Do not upgrade to latest if it is likely to break existing behavior; verify compatibility first.
- For UI primitives/components, use Base UI (https://base-ui.com/llms.txt) and do not introduce Radix UI unless explicitly requested.
- Bundle size is not a concern; this is a backend package. Do not optimize for or flag bundle size.

## Required Checks Before Finishing Work

1. Run type checking:
```bash
bun run type-check
```

2. Run auto-fix formatting/linting:
```bash
bun run lint
bun run fix
```

3. If relevant to your changes, run tests:
```bash
bun run test
```

Do not leave the repo with failing checks.

## Source Layout

The project is a Bun workspace monorepo with three packages under `packages/`:

- `@rova/shared` (`packages/shared`) - runtime-agnostic shared utilities, types, and workflow types
- `@rova/core` (`packages/core`) - library entrypoints, backend code, and frontend SPA
- `@rova/plugins` (`packages/plugins`) - integration plugins and steps

Important paths:
- `packages/core/src/backend/server` - Hono API server
- `packages/core/src/backend/server/routes` - thin route layer (HTTP parsing/response mapping)
- `packages/core/src/backend/services` - domain service logic
- `packages/core/src/backend/lib` - backend-only runtime helpers (DB, logger, workflow engine, steps, Inngest)
- `packages/core/client` - SPA entrypoint and router
- `packages/core/client/lib` - client-only state and API client modules
- `packages/core/client/routes` - route component modules used by TanStack Router
- `packages/core/client/components` - UI components
- `packages/core/client/hooks` - React hooks
- `packages/shared/src` - runtime-agnostic shared utilities, types, and workflow types
- `packages/shared/src/plugins/registry.ts` - plugin metadata registry
- `packages/plugins/src` - integration plugins and steps
- `packages/plugins/src/register-steps.ts` - plugin step importers (side-effect registration)
- `scripts/` - build/runtime scripts
- `server.ts` - root dev server entrypoint

## Backend Architecture

- API framework: Hono (`packages/core/src/backend/app.ts`) -- runtime-agnostic, works on Node.js and Bun
- Dev server: Bun (`server.ts`)
- Library entrypoint: `packages/core/src/hono.ts` exports `createRovaApp()` which returns a mountable Hono app
- API route exports: `packages/core/src/backend/server/routes/index.ts`
- Route handlers should remain light.
- Business/domain logic belongs in `packages/core/src/backend/services/<domain>`.

Server-side barrel files are allowed.

## Frontend Architecture

- This is **not** a Next.js runtime app.
- Client app is a React SPA bootstrapped from `packages/core/client/index.html` and `packages/core/client/main.tsx`.
- Routing uses TanStack Router in `packages/core/client/router.tsx`.

## Deep Technical Architecture

### Runtime Topology

- The backend is a runtime-agnostic Hono app. It uses `postgres` (postgres.js) for DB access and `bcryptjs` for password hashing -- no Bun-specific APIs in shared backend code.
- Local development runs as a single Bun server process from `server.ts`.
- `server.ts` imports `@rova/plugins` and `@rova/plugins/register-steps` for side-effect plugin registration, then starts the server via `@rova/core`.
- SPA shell routes (`/`, `/workflows`, `/workflows/:workflowId`) are served directly from Bun using `packages/core/client/index.html`.
- All `/api/*` traffic is delegated to the Hono app in `packages/core/src/backend/app.ts`.
- Inngest is mounted inside the API at `/api/inngest` using `serveInngest(...)`.
- Local repo development starts `inngest-cli` as a separate process via `bun run dev:inngest`.
- Embedded mode (`createRovaApp(...)` from `packages/core/src/hono.ts`) returns a mountable Hono sub-application. The consumer is responsible for HTTP serving and running Inngest.
- The main package export (`rova-workflows`) provides `createAction` and `createTrigger` only -- no server code.
- The `/hono` export (`rova-workflows/hono`) provides `createRovaApp` and related types.

### API Composition and Boundaries

- `packages/core/src/backend/app.ts` is the canonical API composition root via `createApiApp()`:
  - Accepts optional `basePath` for standalone mode (e.g. `"/api"`); omitting it computes the mount prefix dynamically per-request for embedded use.
  - Declares request schemas with Zod.
  - Applies `zValidator` to params/query/body at route boundaries.
  - Adds centralized request/response logging middleware and `onError` handling.
- Route modules under `packages/core/src/backend/server/routes` are intentionally thin re-export facades over service modules.
- Service modules live in two namespaces:
  - `packages/core/src/backend/services/workflow/*` for execute-specific flow.
  - `packages/core/src/backend/services/workflows/*` for workflow CRUD, webhook entrypoint, and execution/event querying.
- `packages/core/src/backend/lib/http/respond.ts` adapts `ServiceResult` values to HTTP responses where services use typed success/failure return values.

### Data Model and Persistence

- Drizzle schema is defined in `packages/core/src/backend/lib/db/schema.ts`; core tables:
  - `workflows` (workflow metadata + serialized graph JSONB).
  - `workflow_executions` (run lifecycle state, trigger metadata, input/output/error).
  - `workflow_execution_logs` (per-node execution logs).
  - `workflow_wait_states` (delay/hook wait records with correlation keys and hook tokens).
  - `workflow_execution_events` (audit timeline events).
  - `integrations` (encrypted credentials/config).
  - `api_keys` (hashed inbound API credentials).
- DB access is initialized in `packages/core/src/backend/lib/db/index.ts` using a global singleton in dev to avoid hot-reload connection churn.
- Startup migrations are controlled by `RUN_DB_MIGRATIONS=true` in `packages/core/src/backend/lib/db/migrations.ts`.
- Integration configs are encrypted at rest with AES-256-GCM in `packages/core/src/backend/lib/db/integrations.ts` using `INTEGRATION_ENCRYPTION_KEY`.

### Workflow Graph Contract

- Canonical runtime graph shape is the serialized Graphology export stored in `workflows.graph`.
- Shared graph/schema contracts:
  - `packages/shared/src/workflow/schemas.ts` (Zod validation for node/edge/trigger config).
  - `packages/shared/src/workflow/types.ts` (runtime TS types).
  - `packages/shared/src/workflow/graph.ts` (serialize/deserialize helpers).
- Graph invariants are enforced by `packages/core/src/backend/lib/workflow-graph.ts`:
  - No duplicate node/edge IDs.
  - No self-loops.
  - DAG only (cycle detection).
  - At least one trigger node.
  - At least one root trigger (trigger with no incoming edges).

### Trigger Architecture

- Trigger definitions live in `packages/shared/src/workflow/trigger-registry.ts`.
- Built-ins are registered in-process:
  - `Webhook` (`packages/shared/src/workflow/triggers/webhook-trigger.ts`).
  - `Schedule` (`packages/shared/src/workflow/triggers/schedule-trigger.ts`).
  - Fallback/default trigger behavior (`packages/shared/src/workflow/triggers/fallback-trigger.ts`).
- Trigger evaluation yields normalized routing metadata:
  - `eventType`, `correlationKey`, `executionType`, and `routingDecision` (`start`/`restart`/`stop`/`ignore`).
- Project-specific trigger extensions are registered at startup from `packages/core/src/backend/workflow-triggers/index.ts` via `initializeWorkflowTriggers()` (`packages/core/src/backend/lib/workflow-trigger-bootstrap.ts`).

### Node, Trigger, and Action Semantics

- Node types are defined as `trigger | action | add` in shared schemas/types:
  - `trigger`: workflow entrypoint and routing gate.
  - `action`: executable step (system or plugin).
  - `add`: UI-only placeholder node used on homepage before the first real node exists.
- Node data contract (`label`, `description`, `type`, optional `config`, optional `status`, optional `enabled`) is validated in `packages/shared/src/workflow/schemas.ts`.
- Default node behavior:
  - New/home canvas starts with an `add` placeholder (`packages/core/client/routes/page.tsx`).
  - Creating/saving empty workflows injects a default Webhook trigger node (`packages/core/src/backend/services/workflows/workflows-create.workflows.ts`, `packages/core/src/backend/services/workflows/workflows-current.workflows.ts`).
- Handle/connection model:
  - Trigger nodes expose only source handles (`handles: { target: false, source: true }`) in `packages/core/client/components/workflow/nodes/trigger-node.tsx`.
  - Action nodes expose both source and target handles (`packages/core/client/components/workflow/nodes/action-node.tsx`).
  - `add` nodes are non-connectable placeholders.
- Node safety constraints:
  - Trigger nodes cannot be removed from editor operations (`packages/core/client/lib/workflow-store.ts`).
  - Graph validation still enforces at least one root trigger server-side (`packages/core/src/backend/lib/workflow-graph.ts`).
- Node status semantics:
  - Status values: `idle | running | success | error | cancelled`.
  - Execution updates are reflected in node badges and run logs.
  - Disabled action nodes (`enabled === false`) are skipped and emit `null` output so downstream templates do not hard-fail.

### Trigger Configuration and Routing Mechanics

- Trigger selector UI currently exposes first-class `Webhook` and `Schedule` options in `packages/core/client/components/workflow/config/trigger-config.tsx`.
- Runtime-registered custom triggers from `createRovaApp({ triggers })` are exposed through `/api/extensions` and shown in the same selector.
- Custom trigger metadata can include `configFields` and optional `logoUrl`, both rendered by `TriggerConfig`.
- Webhook trigger config includes:
  - Optional schema (`webhookSchema`) for payload structure and template autocomplete.
  - Event/correlation extraction paths (`webhookEventPath`, `webhookCorrelationPath`).
  - Routing event sets (`webhookCreateEvents`, `webhookUpdateEvents`, `webhookDeleteEvents`).
  - Optional mock payload (`webhookMockRequest`) for simulation/manual execute fallback.
- Webhook routing pipeline:
  - Build normalized routing config in `packages/shared/src/workflow/webhook-routing.ts`.
  - Extract `eventType` + `correlationKey` from payload using configured paths.
  - Map event to `create/update/delete/ignore`, then to trigger decisions `start/restart/stop/ignore` in `packages/shared/src/workflow/triggers/webhook-trigger.ts`.
- Schedule trigger semantics:
  - Evaluates as `executionType: "manual"` and always returns `{ kind: "start" }` routing decision (`packages/shared/src/workflow/triggers/schedule-trigger.ts`).
  - UI accepts natural language/cron expression + timezone; cron is normalized for storage (`packages/core/client/components/workflow/config/trigger-config.tsx`).
- Unknown/custom trigger semantics:
  - Unknown trigger types fall back to generic manual-start behavior (`packages/shared/src/workflow/triggers/fallback-trigger.ts`).
  - Project custom triggers are expected to register definitions at bootstrap.

### Action Model and Configuration Mechanics

- Action selection model (`packages/core/client/components/workflow/config/action-config.tsx`):
  - Two-stage selection: `Service` (System or integration category) then `Action`.
  - System actions are hardcoded: `HTTP Request`, `Database Query`, `Condition`, `Wait`.
  - Plugin actions are discovered from registry metadata (`packages/shared/src/plugins/registry.ts`).
  - Runtime actions from `createRovaApp({ actions })` are merged into the same category/action lists.
  - Runtime action metadata can include optional `logoUrl`, rendered in service/action selectors.
- Action configuration model:
  - System action forms are explicit React forms in `ActionConfig`.
  - Plugin actions render declarative field schemas (`configFields`) via `ActionConfigRenderer`.
  - Renderer supports typed fields (`template-input`, `template-textarea`, `text`, `number`, `select`, `schema-builder`) plus `showWhen` conditional visibility.
- Integration binding model:
  - Integration-aware actions require `integrationId` in node config.
  - Integration selector and add-connection overlay are wired in `ActionConfig`.
  - Editor auto-fixes invalid/missing integration references when a single unambiguous replacement exists (`packages/core/client/routes/workflows/[workflowId]/page.tsx`).
- Template reference model:
  - Autocomplete builds upstream node references only (based on incoming edges).
  - Canonical token format: `{{@nodeId:NodeLabel}}` and `{{@nodeId:NodeLabel.field}}` (`packages/core/client/components/ui/template-autocomplete.tsx`).
- Node input autofill behavior:
  - Autofill/autocomplete for node inputs must only suggest variables available from valid upstream context (and trigger schema when applicable).
  - Applying a suggestion should insert/replace only the active token at the cursor/selection; never overwrite unrelated user-authored text in the same field.
  - Autofill must remain user-initiated (explicit selection/confirm) and should not silently rewrite saved node config values on render, focus, or node switch.

### Action Execution Semantics

- Runtime action dispatch (`packages/core/src/backend/lib/workflow-executor.workflow.ts`):
  - System action importers for `Condition`, `HTTP Request`, `Database Query`.
  - Special runtime implementation for `Wait`.
  - Plugin actions resolved via generated step registry (`packages/core/src/backend/lib/step-registry.ts`).
- Run condition behavior:
  - `runCondition` is evaluated for non-Condition actions before execution.
  - False condition produces a skipped result (`run_condition_false`) and workflow continues downstream.
- Condition action behavior:
  - Condition expression is evaluated safely after pre-validation/validation.
  - Downstream nodes execute only when condition result is `true`.
- Wait action behavior:
  - `waitMode=delay`: pause until computed time (`waitDuration` or `waitUntil` +/- `waitOffset`).
  - `waitMode=hook`: wait for `workflow/wait.signal` resume event, optional timeout and explicit hook token.
  - Wait can return `haltBranch` in cases like gate-mode skip when no actual delay remains.
- Dry-run behavior:
  - Non-Condition, non-Wait actions simulate side-effect-free success payloads.
  - Wait and Condition still execute logic relevant to routing/timing semantics.
- Trigger node runtime behavior:
  - If trigger evaluation marks event as ignored/stop, trigger output carries `triggered: false`, and downstream branch is intentionally skipped.

### Execution Orchestration Flow

- Manual execute path:
  - API route: `POST /api/workflow/:workflowId/execute`.
  - Service entry: `packages/core/src/backend/services/workflow/workflow-execute.workflow.ts`.
  - Flow: load workflow -> validate graph/integrations -> evaluate trigger routing -> orchestrate start/cancel/ignore -> enqueue Inngest run.
- Webhook path:
  - API route: `POST /api/workflows/:workflowId/webhook`.
  - Service entry: `packages/core/src/backend/services/workflows/workflow-webhook.workflows.ts`.
  - Flow: validate API key -> validate workflow/trigger -> evaluate routing -> optionally cancel/restart/resume waiting runs -> enqueue new run as needed.
- Shared routing decisions are centralized in `packages/core/src/backend/services/workflows/trigger-orchestrator.workflows.ts`.
- Execution enqueueing uses Inngest runtime events in `packages/core/src/backend/lib/inngest/runtime-events.ts`.

### Inngest Runtime Design

- Function factory: `packages/core/src/backend/lib/inngest/workflow-function.ts`.
  - Creates one function per workflow.
  - Filters events by workflow ID.
  - Configures `cancelOn` for cancel-request events.
- Dynamic function registry: `packages/core/src/backend/lib/inngest/functions.ts`.
  - Loads workflows from DB.
  - Builds function list with short TTL caching.
  - Cache invalidated after workflow create/update/delete/duplicate/current-save mutations.
- Worker execution entrypoint calls `executeWorkflow(...)` in `packages/core/src/backend/lib/workflow-executor.workflow.ts`.

### Workflow Executor Internals

- `executeWorkflow(...)` transforms serialized graph to node/edge maps, discovers root trigger nodes, and executes DAG branches.
- Trigger nodes are evaluated through the shared trigger registry to keep manual/webhook/schedule semantics consistent.
- Action nodes:
  - Resolve template variables from prior node outputs.
  - Dispatch to system actions (`Condition`, `HTTP Request`, `Database Query`, `Wait`) or plugin actions via step registry.
- Wait behavior (`Wait` action) supports:
  - Delay waits via runtime `sleep`.
  - Hook waits via runtime `waitForEvent`.
  - Persistence and transitions in `workflow_wait_states`.
- Step/node logging and workflow completion updates are handled via `packages/core/src/backend/lib/steps/step-handler.ts` and `packages/core/src/backend/lib/workflow-logging.ts`.
- Audit timeline events are written through `packages/core/src/backend/lib/workflow-audit.ts`.

### Plugin and Action System

- Integration/action metadata registry: `packages/shared/src/plugins/registry.ts`.
- Enabled plugins are statically imported in `packages/plugins/src/index.ts` to self-register at boot.
- Plugin step importers are registered via `packages/plugins/src/register-steps.ts` (separate from the frontend-safe barrel).
- Runtime step dispatch uses `packages/core/src/backend/lib/step-registry.ts`:
  - Maps `actionType` IDs to dynamic imports and exported step function names.
  - Includes human-readable labels for UI/logging.
- Action identifiers use `integration/slug` convention, with helpers in plugin registry utilities.
- Plugin step outputs should follow standardized `{ success, data } | { success, error }` wrapper format for consistent logging and templating.

### Frontend Runtime Architecture

- SPA bootstrap in `packages/core/client/main.tsx`:
  - Creates QueryClient.
  - Mounts TanStack Router provider.
  - Applies ResizeObserver patch/suppression safeguards for canvas-heavy rendering.
- Router composition in `packages/core/client/router.tsx`:
  - Root layout provides theme, Jotai state, overlay manager, global modals, and toast host.
  - `PersistentCanvas` keeps the React Flow canvas mounted across home/workflow routes for continuity.
- Primary route modules live under `packages/core/client/routes/**`.
- Workflow editor state is managed in Jotai atoms (`packages/core/client/lib/workflow-store.ts`):
  - Nodes/edges selection and panel state.
  - Undo/redo history.
  - Autosave with debounced and immediate modes.
  - Trigger node deletion safeguards.
- API access is through typed Hono RPC client (`packages/core/client/lib/rpc-client.ts`) that translates between serialized graph payloads and in-memory node/edge structures.

### Cross-Cutting Operational Behaviors

- Logging:
  - Structured app loggers are created via `packages/core/src/backend/lib/logger`.
  - Hono middleware logs request/response metadata; error responses include body snippets in dev.
- Security:
  - Webhook execution requires API key validation.
  - Integration secrets are encrypted before persistence.
  - Step logging redacts sensitive fields before write.
- Consistency:
  - Graph validation happens before write and before execute.
  - Workflow execution lifecycle state is mirrored across `workflow_executions`, `workflow_wait_states`, step logs, and audit events.

## API Client Usage

Use the typed RPC client in:
- `@/lib/rpc-client`

Import pattern:
```ts
import { api } from "@/lib/rpc-client";
```

Do not reference `@/lib/api-client`.

## Database Migrations

- Schema file: `packages/core/src/backend/lib/db/schema.ts`
- Generate migrations: `bun run db:generate`
- Apply migrations locally: `bun run db:push`

Do not hand-write migration SQL in `packages/core/drizzle/`.

## Plugin Guidelines

- Plugin steps should prefer official SDK clients when available and appropriate.
- Do not use a `dependencies` field in plugin `index.ts` for runtime behavior.

## Step Output Format

All plugin steps should return the standardized wrapper format:

```ts
// Success
return { success: true, data: { id: "...", name: "..." } };

// Error
return { success: false, error: { message: "Error description" } };
```

- `outputFields` in plugin `index.ts` should not include `data.` prefixes.
- Template variables unwrap automatically (for example `{{StepName.field}}`).

## Code Cleanliness

- Remove unused imports, variables, and functions.
- Prefer `es-toolkit` helpers for common object/collection cleanup instead of ad-hoc chains.
- Use `omitBy(..., isNil)` (or equivalent predicate) to shape API/update payloads instead of deeply nested conditional spreads.
- Use `compact(...)` instead of `filter(Boolean)` for clearer intent and better typing.
- Use `uniq(...)` and `partition(...)` instead of manual `new Set(...)`/multi-pass `some(...)` patterns when that simplifies logic.
- If `es-toolkit` usage requires unsafe casting, prefer a small typed helper function over repeated inline `as` assertions.
- Use the correct Jotai hook for intent:
  - `useAtom` for read/write
  - `useAtomValue` for read-only
  - `useSetAtom` for write-only
- Do not add compatibility shims for old architecture during active refactors.

## Documentation Guidelines

- No emojis in documentation.
- Do not create new markdown docs unless explicitly requested.
- Keep docs aligned with the current runtime and directory structure.
