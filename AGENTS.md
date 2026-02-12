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

## Required Checks Before Finishing Work

1. Run type checking:
```bash
bun run type-check
```

2. Run auto-fix formatting/linting:
```bash
bun run fix
```

3. If relevant to your changes, run tests:
```bash
bun run test
```

Do not leave the repo with failing checks.

## Source Layout

All application source code lives under `src/`.

Important paths:
- `src/backend/server` - Bun server and Hono API
- `src/backend/server/routes` - thin route layer (HTTP parsing/response mapping)
- `src/backend/services` - domain service logic
- `src/client` - SPA entrypoint and router
- `src/frontend/app` - route component modules used by TanStack Router
- `src/lib` - shared runtime utilities, DB, workflow engine helpers
- `src/plugins` - integration plugins and steps
- `src/scripts` - build/runtime scripts

## Backend Architecture

- Runtime server: Bun (`src/backend/server/index.ts`)
- API framework: Hono (`src/backend/server/hono-app.ts`)
- API route exports: `src/backend/server/routes/index.ts`
- Route handlers should remain light.
- Business/domain logic belongs in `src/backend/services/<domain>`.

Server-side barrel files are allowed.

## Frontend Architecture

- This is **not** a Next.js runtime app.
- Client app is a React SPA bootstrapped from `src/client/index.html` and `src/client/main.tsx`.
- Routing uses TanStack Router in `src/client/router.tsx`.

## API Client Usage

Use the typed RPC client in:
- `@/lib/rpc-client`

Import pattern:
```ts
import { api } from "@/lib/rpc-client";
```

Do not reference `@/lib/api-client`.

## Database Migrations

- Schema file: `src/lib/db/schema.ts`
- Generate migrations: `bun run db:generate`
- Apply migrations locally: `bun run db:push`

Do not hand-write migration SQL in `drizzle/`.

## Plugin Guidelines

- Plugin steps should use `fetch` directly.
- Do not add SDK dependencies for step execution paths.
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
- Use the correct Jotai hook for intent:
  - `useAtom` for read/write
  - `useAtomValue` for read-only
  - `useSetAtom` for write-only
- Do not add compatibility shims for old architecture during active refactors.

## Documentation Guidelines

- No emojis in documentation.
- Do not create new markdown docs unless explicitly requested.
- Keep docs aligned with the current runtime and directory structure.
