---
name: wfgraph-core
description: >
  Use when adding Workflow Graph (@wfgraph/core) to a host application: mounting
  createWfGraphApp on Node, Express, Fastify or Bun, serving the editor with
  clientBundle, setting auth, the encryption key, publicUrl or basePath,
  choosing PostgreSQL or SQLite persistence, running PostgreSQL migrations,
  tuning or moving the worker loop that runs workflows, enabling MCP authoring,
  or keeping inngest.send. Also use for requests such as "add a workflow engine
  to our app", "set up the workflow database", "workflows start but never
  advance" or "the editor loads its assets from the wrong path". For the access
  policy use wfgraph-core/auth; for logs and traces use
  wfgraph-core/observability; for a Cloudflare Worker use
  wfgraph-core/cloudflare-worker; for declaring Events or Entities use
  wfgraph-core/events; for a host's own workflow step use
  wfgraph-core/host-actions; for writing a vendor integration use
  wfgraph-core/integrations; for the six built-in integrations use
  wfgraph-plugins.
metadata:
  purpose: >
    Embed Workflow Graph with createWfGraphApp: fetch handler, createRequestListener,
    auth, INTEGRATION_ENCRYPTION_KEY, clientBundle, publicUrl, basePath,
    MCP authoring, configureWfGraphLogging, wfPostgres, wfSqlite, wfWorker with
    its Cron Trigger and wake Queue,
    migrateWfGraphDatabase, and createWfGraphRunner for a process that only runs
    workflows, plus @wfgraph/core/inngest for a host that keeps inngest.send.
    Load when mounting the host app or choosing persistence. Not for defineEvent,
    defineEntity, defineAction, or defineIntegration (those are sub-skills).
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
pnpm add @wfgraph/core @wfgraph/client @wfgraph/plugins hono
```

`hono` is a peer dependency. `@wfgraph/plugins` is optional. Pass `client`
from `@wfgraph/client` (`clientBundle`) so `wfgraph.fetch` serves the editor.
`createWfGraphApp` takes no `inngest` option and mounts no Inngest route. A
host that publishes with `inngest.send` installs `inngest` (an optional peer)
and registers `createWfGraphInngestFunctions` from `@wfgraph/core/inngest` on
its own `serve` or `connect`: see wfgraph-core/events.

## Sub-skills

| Need to...                               | Load                           |
| ---------------------------------------- | ------------------------------ |
| Write the `auth` access policy           | wfgraph-core/auth              |
| Route logs and traces                    | wfgraph-core/observability     |
| Deploy on a Cloudflare Worker            | wfgraph-core/cloudflare-worker |
| `defineEvent`, `defineEntity`, Lifecycle | wfgraph-core/events            |
| `defineAction` (Promise host actions)    | wfgraph-core/host-actions      |
| Write a vendor integration               | wfgraph-core/integrations      |
| Turn on Clerk/Linear/Resend/Slack/Twilio | wfgraph-plugins                |

## Embedding pitfalls

- `createWfGraphApp` returns `{ fetch, basePath, events, dispose, [Symbol.asyncDispose] }`. `fetch`
  is `(request: Request) => Promise<Response>`. Use `await using` for a lexical lifetime;
  call `dispose()` from a long-running host's shutdown handler.
- `auth` is required: a callback that returns an access policy for the
  request's session, or `null` for a request with none. Roles, custom grants,
  `trustWfGraphUpstream()` and the 401, 403 and 500 answers: wfgraph-core/auth.
- `INTEGRATION_ENCRYPTION_KEY` is 64-character hex (`openssl rand -hex 32`).
- Mount `createRequestListener(wfgraph)` **before** any body parser, at the
  same path as `basePath`. Express strips the matched path; the adapter reads
  `req.originalUrl`. A drained body makes webhook signature verification fail.
- With no logging set up, Workflow Graph's records are dropped and start-up
  warns once. The quickest setup is `configureWfGraphLogging()` from
  `@wfgraph/core/logging`, called before `createWfGraphApp`. A host with its
  own logger or LogTape configuration, and tracing: wfgraph-core/observability.
- OAuth needs `publicUrl` (HTTPS except loopback). The callback stays behind
  `auth`, so the session must ride on a cookie: wfgraph-core/auth. Slack/Resend
  on/off: wfgraph-plugins.
- `mcp: true` enables the authenticated stateless MCP endpoint for localhost.
  For a deployed host, set `mcp.allowedHostnames` and
  `mcp.allowedOriginHostnames`. `create_workflow` creates a draft containing the
  default Lifecycle Node. It takes a required `name` and optional `description`,
  requires `workflow.create`, and returns `workflowId` and `draftRevision`.
  Creation is not idempotent; do not automatically retry after an unknown result.
  Every caller granted `workflow.getAll` can use `list_workflows` to discover
  available workflow IDs. Existing-draft authoring calls take a `workflowId`;
  writes also take the latest `expectedDraftRevision`. After a
  `workflow_draft_stale` result, read the workflow again before editing.
- MCP tools and the build agent keep existing Groups valid and cannot create a
  Group or ungroup one. A write that leaves a Group with
  fewer than two steps ungroups it, and the tool result names that Group.
- Grouping never changes what a run executes. A draft save refuses Group
  membership errors and edges that touch a Group frame. The remaining Group rules block Publish, and a draft run
  ignores them.

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
- Cloudflare Workers: `wfWorker` from `@wfgraph/core/worker` with
  `wfHyperdrive(env.HYPERDRIVE)`. A Worker runs no worker loop, takes no
  `runner` option, and needs a Cron Trigger: wfgraph-core/cloudflare-worker.

## Workflow runs

Runs execute in the host's process on a worker loop that `createWfGraphApp`
starts, with their schedule and step memo in the `persistence` database. The
same loop delivers every Event from the event inbox, however the Event arrived.
Loop defaults and the `runner` fields: `docs/embedding.md` ("Workflow runs").

- `runner` left out runs one loop. `runner: false` runs none in that process;
  some process on the same database must run one, such as a
  `createWfGraphRunner` process ("Run the loop in its own process"). SQLite
  refuses `runner: false`, and `createWfGraphRunner` refuses SQLite.
- SQLite runs every pass on the host's main thread (`node:sqlite` is
  synchronous). Concurrency defaults to 1 there.
- `runner.heartbeatMs` must be shorter than `runner.leaseMs`; startup refuses
  otherwise.
- Event deliveries take slots of their own (`runner.deliveryConcurrency`,
  default 1), so a long run holding every run slot does not delay a Cancel.
  Cron schedule fires take one slot of their own beside them.
- The loop deletes settled inbox rows older than `events.retentionMs` (default
  seven days, a positive integer of at most 100 years or startup refuses).
  It never deletes a pending row. Every process running a loop sweeps with its
  own `events.retentionMs`, so set the same window in the app and every runner.
- Run history is kept forever unless `runs.retentionMs` is set. With it, the
  loop deletes ended Executions older than the window, with their logs and
  timelines, workflow audit rows naming no run, and draft snapshots no run
  references and no Draft run pinned within the window (`last_pinned_at`).
  Published versions stay. A run, or a Refused Start, recorded for an Event's
  delivery is kept while that delivery's inbox row exists, because a
  redelivery is answered from it. Startup refuses a value outside one hour to
  100 years. Set the same window in the app and every runner.
- `dispose()` stops the loop and waits up to ten seconds for passes in flight.
- Runs that an earlier release left in Inngest have no schedule row and never
  advance. Drain them before upgrading.

## Common mistakes

### CRITICAL Missing authorization boundary

Wrong: `createWfGraphApp({ persistence, encryption, extensions })` with no `auth`.

Correct: `auth: defineWfGraphAuth((request) => accessForSession(request))`,
with the policy written as wfgraph-core/auth describes.

`auth` is a required option, so the call fails to type-check without it. A
JavaScript host that omits it still starts, and every operator request answers
`500`. The failure to avoid is an editor the internet can open that decrypts
integration secrets.

Source: alandotcom/wfgraph:docs/embedding.md (createWfGraphApp options)

### HIGH Pass an inngest option to createWfGraphApp

Wrong: `createWfGraphApp({ ..., inngest: { id: "my-app", connect: true } })`,
or `/api/inngest` registered as Workflow Graph's Inngest endpoint.

Correct: drop the option, which no longer type-checks. Keep `inngest.send` by
building `createWfGraphInngestFunctions({ client, app })` from
`@wfgraph/core/inngest` and registering them with your own Inngest client's
`serve` or `connect`. Signing keys and Connect settings belong to that client.

Source: alandotcom/wfgraph:docs/events.md (Sending through Inngest)

### HIGH Body parser in front of the listener

Wrong: `app.use(express.json())` then `app.use("/workflows", createRequestListener(wfgraph))`.

Correct: mount the listener first, then the parser.

A connection webhook verifies the raw body. A drained request cannot be rebuilt.

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

### CRITICAL No process runs the worker loop

Wrong: `createWfGraphApp({ ..., runner: false })` in every process.

Correct: leave `runner` out (or pass an object) in at least one process
connected to the same database, or run `createWfGraphRunner` beside the apps.

Runs open and never advance: nothing claims their schedule rows.

Source: alandotcom/wfgraph:docs/embedding.md (Workflow runs)

### HIGH Upgrade with legacy Group config keys

Wrong: Upgrade while a stored draft or published version has keys in a Group's
config, including `direction`, `entryNodeIds`, `exitNodeIds`, or `outletHandle`.

Correct: Before upgrading, empty each stored Group config. Graph decoding
refuses every Group config key, and no migration ships for the removed keys.

Source: alandotcom/wfgraph:docs/embedding.md (Groups)

### HIGH Repeat a stale MCP write

Wrong: Repeat the same MCP write after a `workflow_draft_stale` result.

Correct: Call `read_workflow`, evaluate the change against the updated draft,
and send the write with the returned `draftRevision`.

A stale write can refer to graph state that another editor changed. Workflow
Graph does not replay the mutation automatically.

Source: alandotcom/wfgraph:docs/embedding.md (MCP authoring)
