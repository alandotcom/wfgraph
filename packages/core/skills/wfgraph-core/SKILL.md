---
name: wfgraph-core
description: >
  Embed Workflow Graph with createWfGraphApp: fetch handler, createRequestListener,
  auth, INTEGRATION_ENCRYPTION_KEY, Inngest, clientBundle, publicUrl, basePath,
  configureWfGraphLogging, wfPostgres, wfSqlite, wfWorker, migrateWfGraphDatabase.
  Load when mounting the host app or choosing persistence. Not for defineEvent,
  defineAction, or defineIntegration (those are sub-skills).
metadata:
  type: core
  library: wfgraph
  library_version: "3.1.1"
sources:
  - alandotcom/wfgraph:README.md
  - alandotcom/wfgraph:docs/embedding.md
---

# Workflow Graph — core

Workflow Graph is a self-hosted workflow engine you embed. Nothing registers on
import. Pass Events, actions, and integrations in `extensions`.

Copy-paste the mount from `README.md` ("Embed in your app") and the option
table from `docs/embedding.md`. This skill is the failure modes around that
mount, not a second copy of it.

```bash
pnpm add @wfgraph/core @wfgraph/client @wfgraph/plugins inngest hono
```

`inngest` and `hono` are peer dependencies. `@wfgraph/plugins` is optional.
Pass `client` from `@wfgraph/client` (`clientBundle`) so `wfgraph.fetch` serves
the editor.

## Sub-skills

| Need to...                               | Load                      |
| ---------------------------------------- | ------------------------- |
| `defineEvent`, intake, Lifecycle         | wfgraph-core/events       |
| `defineAction` (Promise host actions)    | wfgraph-core/host-actions |
| Write a vendor integration               | wfgraph-core/integrations |
| Turn on Clerk/Linear/Resend/Slack/Twilio | wfgraph-plugins           |

## Embedding pitfalls

- `createWfGraphApp` returns `{ fetch, basePath, dispose, [Symbol.asyncDispose] }`. `fetch`
  is `(request: Request) => Promise<Response>`. Use `await using` for a lexical lifetime;
  call `dispose()` from a long-running host's shutdown handler.
- `auth` is required and returns an access policy or `null`. Use
  `WfGraphRoles`, `WfGraphAccess`, and `defineWfGraphAuth`; use
  `trustWfGraphUpstream()` only behind a trusted upstream boundary. The full
  contract and canonical example live in `docs/embedding.md`.
- Load remote grants during authentication. A custom policy's `allows` method
  is called concurrently for the editor snapshot and again for each real
  operation, so a database lookup there creates avoidable fanout.
- `INTEGRATION_ENCRYPTION_KEY` is 64-character hex (`openssl rand -hex 32`).
- Mount `createRequestListener(wfgraph)` **before** any body parser, at the
  same path as `basePath`. Express strips the matched path; the adapter reads
  `req.originalUrl`. A drained body makes Inngest signature verification fail.
- Call `configureWfGraphLogging()` before `createWfGraphApp`, or pass `logger`,
  or sink LogTape category `wfgraph`. With none of those, start-up warns once.
  Never log a request body, Event payload, or step output.
- OAuth needs `publicUrl` (HTTPS except loopback). The callback stays behind
  `auth`; a `SameSite=Lax` session cookie works, a custom request header on the
  provider redirect does not. Slack/Resend on/off: wfgraph-plugins.

## Persistence

`createWfGraphApp` takes one opaque `persistence` value. Forms live under
`docs/embedding.md` ("Persistence", "Cloudflare Workers and Hyperdrive",
"PostgreSQL migrations").

- PostgreSQL 15+: `wfPostgres` takes a `url` **or** discrete fields, not both.
- Default schema is `_workflows`. Tables are unqualified; `search_path` places
  them. A `url` must not carry a `search_path` query parameter.
- `runOnStartup` defaults to `false`. Out of band: `migrateWfGraphDatabase`
  from `@wfgraph/core/migrate`. Do not apply the shipped SQL with `psql` — the
  files are schema-agnostic and would land in `public`.
- SQLite: `wfSqlite({ filename })` or `wfSqlite()` (in-memory, dies with the
  process).
- Cloudflare Workers: `@wfgraph/core/worker` (`wfWorker` / `wfHyperdrive`),
  not `createWfGraphApp`. Disable Hyperdrive query caching. Set the origin
  role's default `search_path`. Migrate out of band. Enable `nodejs_compat`.

## Common mistakes

### CRITICAL Missing authorization boundary

Wrong: `createWfGraphApp({ persistence, encryption, inngest })` with no `auth`.

Correct: `auth: defineWfGraphAuth((request) => accessForSession(request))`
(or `trustWfGraphUpstream()` when an upstream component enforces authorization
too). Return `WfGraphAccess.all` when unrestricted authenticated access is
intentional.

Workflow Graph refuses to start without it. The failure to avoid is an editor
the internet can open that decrypts integration secrets.

Source: alandotcom/wfgraph:docs/embedding.md (createWfGraphApp options)

### HIGH Body parser in front of the listener

Wrong: `app.use(express.json())` then `app.use("/workflows", createRequestListener(wfgraph))`.

Correct: mount the listener first, then the parser.

Inngest verifies the raw body. A drained request cannot be rebuilt.

Source: alandotcom/wfgraph:docs/embedding.md (Mounting on Node)

### HIGH Mount path disagrees with basePath

Wrong: `basePath: "/"` while `app.use("/workflows", createRequestListener(wfgraph))`.

Correct: `basePath: "/workflows"` matches the mount. The adapter logs once when
they disagree; OAuth callback URLs will be wrong.

Source: alandotcom/wfgraph:docs/embedding.md (Mounting on Node)

### HIGH Mix url and discrete postgres fields

Wrong: `wfPostgres({ url: process.env.DATABASE_URL!, host: "db.internal" })`.

Correct: one form only. Mixed values fail to compile and are refused at runtime.

Source: alandotcom/wfgraph:docs/embedding.md (Persistence)

### HIGH Apply drizzle SQL with psql

Wrong: `psql $DATABASE_URL -f node_modules/@wfgraph/core/drizzle/...`

Correct: `migrateWfGraphDatabase` or `wfPostgres({ migrations: { runOnStartup: true } })`.

Source: alandotcom/wfgraph:docs/embedding.md (PostgreSQL migrations)

### HIGH Hyperdrive with query caching

Wrong: default Hyperdrive caching on.

Correct: disable query caching; Workflow Graph's writes would otherwise be
invisible to later reads.

Source: alandotcom/wfgraph:docs/embedding.md (Cloudflare Workers and Hyperdrive)
