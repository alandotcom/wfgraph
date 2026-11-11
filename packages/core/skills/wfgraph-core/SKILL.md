---
name: wfgraph-core
description: >
  Use when adding Workflow Graph (@wfgraph/core) to a host application: mounting
  createWfGraphApp on Node, Express, Fastify or Bun, serving the editor with
  clientBundle, setting auth, the encryption key, publicUrl or basePath,
  choosing PostgreSQL or SQLite persistence, running PostgreSQL migrations,
  tuning or moving the worker loop that runs workflows, adding a readiness
  probe, or keeping inngest.send. Also use for requests such as "add a
  workflow engine to our app", "workflows start but never advance" or "the
  editor loads its assets from the wrong path". Other tasks have their own
  skill: the access policy is wfgraph-core/auth, logs and traces
  wfgraph-core/observability, MCP clients wfgraph-core/mcp, the editor's chat
  agent wfgraph-core/build-agent, a Cloudflare Worker
  wfgraph-core/cloudflare-worker, Events and Entities wfgraph-core/events, a
  host's own step wfgraph-core/host-actions, a vendor integration
  wfgraph-core/integrations, and the six built-in integrations
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
| Let an MCP client author workflows       | wfgraph-core/mcp               |
| Turn on or host the editor's chat agent  | wfgraph-core/build-agent       |
| Deploy on a Cloudflare Worker            | wfgraph-core/cloudflare-worker |
| `defineEvent`, `defineEntity`, Lifecycle | wfgraph-core/events            |
| `defineAction` (Promise host actions)    | wfgraph-core/host-actions      |
| Write a vendor integration               | wfgraph-core/integrations      |
| Turn on Clerk/Linear/Resend/Slack/Twilio | wfgraph-plugins                |

## Embedding pitfalls

- `createWfGraphApp` returns `{ fetch, basePath, events, health, dispose, [Symbol.asyncDispose] }`.
  `fetch` is `(request: Request) => Promise<Response>`. Use `await using` for a lexical
  lifetime; call `dispose()` from a long-running host's shutdown handler.
- `auth` is required: a function of the request that returns an access policy
  for its session, or `null` or `undefined` for a request with none, or an
  object holding that function as `authenticate`. `createWfGraphApp` refuses
  anything else at startup. Roles, custom grants, `trustWfGraphUpstream()` and
  the 401, 403 and 500 answers: wfgraph-core/auth.
- `encryption.key` is 64-character hex (`openssl rand -hex 32`), conventionally
  read from `INTEGRATION_ENCRYPTION_KEY`. It is required once
  `extensions.integrations` declares an integration, since it seals Connection
  credentials and OAuth grants; an app with no integration may leave
  `encryption` out. A key that is passed must be valid either way.
- `health: true` mounts `GET {basePath}/api/health` for a readiness probe. It
  answers outside `auth` with booleans alone: 200 when the database answers
  and this process's loop, if it runs one, turned recently, and 503 otherwise.
  `app.health()` is the same check for a host's own endpoint, never rejects,
  and also answers `queue`, the work due across every loop, which the route
  leaves out. Copy the shapes from `docs/embedding.md` ("Readiness").
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
- `mcp` turns on the MCP authoring endpoint, and `agent` turns on the editor's
  chat agent. Both are off by default: wfgraph-core/mcp and
  wfgraph-core/build-agent.
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
- `createWfGraphRunner` takes the options object `createWfGraphApp` takes.
  Build it once in a module both processes import, pass
  `{ ...options, runner: false }` to the app and `options` to the runner. The
  runner ignores `auth` (optional for it), `client`, `mcp`, `agent`,
  `events.key` and `runner: false`, and always runs a loop.
- SQLite runs every pass on the host's main thread (`node:sqlite` is
  synchronous). Concurrency defaults to 1 there. On PostgreSQL it defaults to
  `min(10, max(1, floor(maxConnections / 2)))`, 5 for the default pool of 10,
  so the delivery and cron lanes and the app's HTTP requests keep the other
  half of the pool. A `runner.concurrency` you set is used as it is.
- `runner.maxStepValueBytes` (1 MiB of JSON by default) caps what one durable
  step may answer. A step answering more fails its node at once with no retry,
  and the node's error names the step and the size.
- `runner.heartbeatMs` must be shorter than `runner.leaseMs`; startup refuses
  otherwise.
- Event deliveries take slots of their own (`runner.deliveryConcurrency`,
  default 1), so a long run holding every run slot does not delay a Cancel.
  Cron schedule fires take one slot of their own beside them.
- A Cancel Event follows the order Events were received in, whatever order
  they are delivered in: it reaches a run whose start Event was received no
  later than it, and never one whose start Event was received after it.
- An event-mode Wait that first parks after a matching Event was delivered,
  since its run started, wakes at once with it. The run's own start and
  Cancel Events, and an Event that already woke one of its Waits, never count.
- The loop deletes settled inbox rows older than `events.retentionMs` (default
  seven days, a positive integer of at most 100 years or startup refuses).
  It never deletes a pending row. Every process running a loop sweeps with its
  own `events.retentionMs`, which the shared options object keeps equal.
- Run history is kept forever unless `runs.retentionMs` is set. With it, the
  loop deletes ended Executions older than the window, with their logs and
  timelines, workflow audit rows naming no run, and draft snapshots no run
  references and no Draft run pinned within the window (`last_pinned_at`).
  Published versions stay. A run, or a Refused Start, recorded for an Event's
  delivery is kept while that delivery's inbox row exists, because a
  redelivery is answered from it. Startup refuses a value outside one hour to
  100 years. Every process running a loop sweeps with its own window, as for
  `events.retentionMs`.
- `dispose()` stops the loop and waits up to ten seconds for passes in flight.
  A pass still running then has its steps stopped; a step written as a plain
  Promise cannot be stopped, so its run is held back one lease before another
  loop claims it.
- Runs that an earlier release left in Inngest have no schedule row and never
  advance. Drain them before upgrading.

## Common mistakes

### CRITICAL Missing authorization boundary

Wrong: `createWfGraphApp({ persistence, encryption, extensions })` with no `auth`.

Correct: `auth: (request) => accessForSession(request)`, with the policy
written as wfgraph-core/auth describes.

`auth` is a required option, so the call fails to type-check without it, and
`createWfGraphApp` refuses a missing or malformed value at startup with a
message naming the option. The failure to avoid is a policy that answers every
request with access, which `auth` accepts: an editor the internet can open that
decrypts integration secrets.

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

### HIGH Separate options for the app and the runner

Wrong: `createWfGraphRunner({ persistence, encryption: { key: otherKey } })`
written beside a `createWfGraphApp` call that builds its own options.

Correct: one options object in a shared module, passed as
`{ ...options, runner: false }` to the app and `options` to the runner.

A runner given another key, extension list or retention window starts without
a complaint. Its loop then cannot read the Connections the app stored, refuses
nodes whose actions it does not declare, or deletes history on a window the
app never set.

Source: alandotcom/wfgraph:docs/embedding.md (Run the loop in its own process)

### HIGH Upgrade with legacy Group config keys

Wrong: Upgrade while a stored draft or published version has keys in a Group's
config, including `direction`, `entryNodeIds`, `exitNodeIds`, or `outletHandle`.

Correct: Before upgrading, empty each stored Group config. Graph decoding
refuses every Group config key, and no migration ships for the removed keys.

Source: alandotcom/wfgraph:docs/embedding.md (Groups)
