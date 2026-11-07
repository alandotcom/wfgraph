---
name: wfgraph-core
description: >
  Embed Workflow Graph with createWfGraphApp: fetch handler, createRequestListener,
  auth, INTEGRATION_ENCRYPTION_KEY, clientBundle, publicUrl, basePath,
  MCP authoring, configureWfGraphLogging, wfPostgres, wfSqlite, wfWorker with
  its Cron Trigger and wake Queue,
  migrateWfGraphDatabase, and createWfGraphRunner for a process that only runs
  workflows, plus @wfgraph/core/inngest for a host that keeps inngest.send.
  Load when mounting the host app or choosing persistence. Not for defineEvent,
  defineEntity, defineAction, or defineIntegration (those are sub-skills).
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
pnpm add @wfgraph/core @wfgraph/client @wfgraph/plugins hono
```

`hono` is a peer dependency. `@wfgraph/plugins` is optional. Pass `client`
from `@wfgraph/client` (`clientBundle`) so `wfgraph.fetch` serves the editor.
`createWfGraphApp` takes no `inngest` option and mounts no Inngest route. A
host that publishes with `inngest.send` installs `inngest` (an optional peer)
and registers `createWfGraphInngestFunctions` from `@wfgraph/core/inngest` on
its own `serve` or `connect`: see wfgraph-core/events.

## Sub-skills

| Need to...                               | Load                      |
| ---------------------------------------- | ------------------------- |
| `defineEvent`, `defineEntity`, Lifecycle | wfgraph-core/events       |
| `defineAction` (Promise host actions)    | wfgraph-core/host-actions |
| Write a vendor integration               | wfgraph-core/integrations |
| Turn on Clerk/Linear/Resend/Slack/Twilio | wfgraph-plugins           |

## Embedding pitfalls

- `createWfGraphApp` returns `{ fetch, basePath, events, dispose, [Symbol.asyncDispose] }`. `fetch`
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
  `req.originalUrl`. A drained body makes webhook signature verification fail.
- Call `configureWfGraphLogging()` before `createWfGraphApp`, or pass `logger`,
  or sink LogTape category `wfgraph`. With none of those, start-up warns once.
  Never log a request body, Event payload, or step output.
- OAuth needs `publicUrl` (HTTPS except loopback). The callback stays behind
  `auth`; a `SameSite=Lax` session cookie works, a custom request header on the
  provider redirect does not. Slack/Resend on/off: wfgraph-plugins.
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
  `wfHyperdrive(env.HYPERDRIVE)`, the module's default export. Its `fetch`
  serves the API, and its `scheduled` and `queue` handlers each run a tick
  that advances the due runs and deliveries. A Worker runs no `runner` loop and
  `createWfGraphRunner` refuses Hyperdrive.
- The Worker needs a Cron Trigger that fires every minute; without it nothing
  advances. A Queue is optional: pass its producer binding as
  `request(env).wakeQueue` and make the same Worker its consumer, and a write
  that makes a run due starts a tick at once. Without the Queue, Events are
  delivered up to a minute late. A Wait's deadline resumes on the Cron
  Trigger, within a minute, with or without the Queue.
- A tick's wall-time, lease and CPU bounds, and when to raise `limits.cpu_ms`:
  `docs/embedding.md` ("Ticks and the platform limits").

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
- The loop deletes settled inbox rows older than `events.retentionMs` (default
  seven days, a positive integer or startup refuses). It never deletes a
  pending row. Every process running a loop sweeps with its own
  `events.retentionMs`, so set the same window in the app and every runner.
- Run history is kept forever unless `runs.retentionMs` is set. With it, the
  loop deletes ended Executions older than the window, with their logs and
  timelines, workflow audit rows naming no run, and draft snapshots no run
  references. Published versions stay. Startup refuses a value below the
  inbox window (`events.retentionMs`, default seven days), because a
  redelivered inbox row is answered from the run it opened. Set the same
  window in the app and every runner.
- `dispose()` stops the loop and waits up to ten seconds for passes in flight.
- Runs that an earlier release left in Inngest have no schedule row and never
  advance. Drain them before upgrading.

## Common mistakes

### CRITICAL Missing authorization boundary

Wrong: `createWfGraphApp({ persistence, encryption, extensions })` with no `auth`.

Correct: `auth: defineWfGraphAuth((request) => accessForSession(request))`
(or `trustWfGraphUpstream()` when an upstream component enforces authorization
too). Return `WfGraphAccess.all` when unrestricted authenticated access is
intentional.

Workflow Graph refuses to start without it. The failure to avoid is an editor
the internet can open that decrypts integration secrets.

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

### CRITICAL A Worker with no Cron Trigger

Wrong: deploying `wfWorker` with only a Queue consumer, or with neither.

Correct: `[triggers] crons = ["* * * * *"]` in the Wrangler configuration,
and the Queue beside it when Events must be delivered at once.

The Cron Trigger's tick is what finds a Wait's deadline, a run whose
invocation was cut short, and Events a host inserted itself. Without it those
runs never advance.

Source: alandotcom/wfgraph:docs/embedding.md (Cloudflare Workers and Hyperdrive)

### HIGH Hyperdrive with query caching

Wrong: default Hyperdrive caching on.

Correct: disable query caching; Workflow Graph's writes would otherwise be
invisible to later reads.

Source: alandotcom/wfgraph:docs/embedding.md (Cloudflare Workers and Hyperdrive)

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
