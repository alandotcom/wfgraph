---
name: cloudflare-worker
description: >
  Use when deploying Workflow Graph on a Cloudflare Worker with
  @wfgraph/core/worker: exporting wfWorker with its fetch, scheduled and queue
  handlers, resolving bindings and secrets in its request callback, writing the
  Wrangler configuration for the Cron Trigger and the optional wake Queue,
  connecting PostgreSQL through Hyperdrive with wfHyperdrive and query caching
  disabled, setting the origin role's search_path, running migrations outside
  the Worker, raising limits.cpu_ms, or reading tick records. Also use for
  requests such as "run our workflows on Cloudflare", "runs on the Worker never
  resume after a wait", "Events reach the Worker a minute late" or "the Worker
  says current_schema() resolved to public". For a Node host, its worker loop
  or createWfGraphRunner use wfgraph-core; for the auth callback use
  wfgraph-core/auth; for log sinks and tracing use wfgraph-core/observability.
metadata:
  purpose: >
    Deploy Workflow Graph on a Cloudflare Worker with wfWorker, a Cron Trigger,
    an optional wake Queue, Hyperdrive with query caching off, out-of-band
    migrations and the platform limits.
  type: sub-skill
  library: wfgraph
  library_version: "3.1.1"
requires:
  - wfgraph-core
sources:
  - alandotcom/wfgraph:docs/embedding.md
  - alandotcom/wfgraph:packages/core/src/backend/worker.ts
  - alandotcom/wfgraph:packages/core/src/backend/persistence/hyperdrive-postgres.ts
---

This skill builds on wfgraph-core. Copy the Worker entry and the Wrangler
configuration from `docs/embedding.md` ("Cloudflare Workers and Hyperdrive"),
and the migration call from "PostgreSQL migrations".

# Workflow Graph on a Cloudflare Worker

`@wfgraph/core/worker` runs Workflow Graph on a Worker with PostgreSQL through
Hyperdrive. A Worker invocation has no long-lived process, so the Worker runs
no worker loop: its runs advance in ticks. A tick claims the due runs and Event
deliveries, runs each until it finishes or parks at a Wait, and returns.
`wfWorker` answers three handlers for the module's default export:

- `fetch` serves the API, as `createWfGraphApp` does.
- `scheduled` runs a tick for the Cron Trigger.
- `queue` runs a tick when a run wake arrives on the optional Queue.

The `runner` option does not exist on `wfWorker`, and `createWfGraphRunner`
refuses `wfHyperdrive` at startup, so no process outside the Worker advances
its runs.

## Procedure

1. **Create Hyperdrive with caching off.** Pass `--caching-disabled` to
   `wrangler hyperdrive create`. Set the PostgreSQL origin role's default
   `search_path` so `_workflows` comes first, or the `schema` you pass as
   `wfHyperdrive(env.HYPERDRIVE, { schema })`. Result: an invocation opens
   without the error "Hyperdrive's PostgreSQL origin resolved
   current_schema() to ...".
2. **Migrate outside the Worker.** Run `migrateWfGraphDatabase` from
   `@wfgraph/core/migrate` in CI or a release step, against the origin
   database with the same `schema`. `wfHyperdrive` takes no migration option.
   Result: the Workflow Graph tables exist in that schema before the Worker
   deploys.
3. **Write the entry.** Export `wfWorker<Env>({ ... })` as the default export.
   Resolve every binding and secret inside `request(env)`, which `wfWorker`
   calls once per invocation of each handler: `auth`, `persistence:
   wfHyperdrive(env.HYPERDRIVE)`, `encryption.key`, and optionally
   `events.key`, `events.retentionMs`, `runs.retentionMs`, `wakeQueue` and
   `agent`. `basePath`, `publicUrl`, `entityResolverTimeoutMs`, `mcp`,
   `logger` and `extensions` go on `wfWorker` itself; `extensions` may be a
   function of the environment. Result: the entry type-checks against
   `@wfgraph/core/worker`, and loading it does not throw (a `publicUrl` that
   carries a path throws when the module loads).
4. **Write the Wrangler configuration.** Node.js compatibility on (the
   `nodejs_compat` flag, or a compatibility date of `2026-08-04` or later), the
   `[[hyperdrive]]` binding, `[triggers] crons = ["* * * * *"]`, and, for the
   Queue, a producer binding passed as `wakeQueue` plus a consumer on the same
   Worker with `max_batch_timeout = 0`. Result: a run whose Wait deadline has
   passed resumes within a minute.
5. **Share the Worker with other routes only by delegation.** A Worker with
   its own routes, crons or queues calls `fetch(request, env, ctx)`,
   `scheduled(controller, env)` and `queue(batch, env)` from its own handlers,
   passes `ctx` through so `fetch` can close the invocation with
   `ctx.waitUntil`, and hands `queue` only the wake Queue's batches, chosen by
   `batch.queue`.

## Core Patterns

### What the Cron Trigger and the Queue each do

| Situation                                         | Cron Trigger only                        | Cron Trigger and Queue                   |
| ------------------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| An Event, Cancel, resume or Migration via `fetch` | Next minute's tick                       | A tick starts at once                    |
| A Wait's deadline passes                          | Next minute's tick                       | Next minute's tick                       |
| A run whose invocation the platform killed        | A Cron Trigger tick after its lease ends | A Cron Trigger tick after its lease ends |
| An Event the host inserted into the inbox itself  | Next minute's tick                       | Next minute's tick                       |
| Inbox and run-history retention sweeps            | Each Cron Trigger tick                   | Each Cron Trigger tick                   |

A Queue message names no run, since a tick claims every due row, and a tick
sends no message of its own. A send the Queue refuses is logged, and the next
Cron Trigger tick finds the run.

### Ticks and the platform limits

- **Wall time.** Cloudflare ends a Cron Trigger or Queue invocation after 15
  minutes. A tick claims for its first 10 minutes and cuts any pass still
  running at 14. A cut pass hands its run back due at once and counts one
  failure against its step, so a step longer than every tick spends its
  retries and fails its node.
- **Leases.** A tick holds each run under a five-minute lease renewed every
  minute. A run whose invocation the platform killed is claimed again by a
  tick about six minutes later at most.
- **CPU time.** A tick stops claiming after 100 passes and records
  `stopped: "pass_limit"`; the next tick takes the rest. A Queue consumer gets
  30 seconds of CPU by default on the Paid plan, which `limits.cpu_ms` raises
  to at most 300,000. Waiting on the database or an action's requests is not
  CPU time.
- **Statements.** Hyperdrive ends a statement after 60 seconds; a tick holds no
  transaction across a step.

### Tick records

Each tick writes one record: "Tick finished", "Tick finished; its budget cut a
pass" at warning level, "Tick found nothing due" at debug level, or "Tick
failed". The `tick` group names the trigger, the worker id
(`cf-worker:cron:<id>` or `cf-worker:queue:<id>`, also written on each row it
leases), the duration and why it stopped, beside its passes counted by kind and
by result. A tick that fails to open the database, dies or fails to close
rethrows after its record, so the Queue retries the batch. The tick runs in a
`wfgraph.worker.tick` span. Where records and spans go:
wfgraph-core/observability.

## Common Mistakes

### CRITICAL A Worker with no Cron Trigger

Wrong: deploying `wfWorker` with only a Queue consumer, or with neither.

Correct: `[triggers] crons = ["* * * * *"]` in the Wrangler configuration,
and the Queue beside it when Events must be delivered at once.

The Cron Trigger's tick is what finds a Wait's deadline, a run whose
invocation was cut short, and Events a host inserted itself. With a Queue
alone, a run parks at its first Wait and never resumes; with neither, no Event
is ever delivered.

Source: alandotcom/wfgraph:docs/embedding.md (Wake runs through a Queue)

### HIGH Hyperdrive with query caching

Wrong: a Hyperdrive configuration created with its default query caching.

Correct: `wrangler hyperdrive create ... --caching-disabled`.

Hyperdrive does not invalidate cached reads after Workflow Graph writes, so a
later read misses those writes.

Source: alandotcom/wfgraph:docs/embedding.md (Hyperdrive)

### HIGH An origin role without the search_path

Wrong: the origin role's default `search_path` left at `"$user", public`.

Correct: `ALTER ROLE <role> SET search_path = _workflows` (or the `schema`
passed to `wfHyperdrive`) on the origin database.

Hyperdrive pools connections, so the schema cannot ride on the connection.
Every invocation checks `current_schema()` and refuses a mismatch, so the
Worker answers no request.

Source: alandotcom/wfgraph:docs/embedding.md (Hyperdrive)

### HIGH A runner beside the Worker

Wrong: `createWfGraphRunner({ persistence: wfHyperdrive(...) })` to run the
Worker's workflows elsewhere, or `runner` settings on `wfWorker`.

Correct: the Cron Trigger and the optional Queue; a tick's budget, lease and
pass limit are constants sized to the platform.

`createWfGraphRunner` refuses Hyperdrive with "This persistence backend runs no
long-lived worker loop", and `wfWorker` takes no `runner` option.

Source: alandotcom/wfgraph:docs/embedding.md (Run the loop in its own process)

### MEDIUM The Queue's default batch timeout

Wrong: a wake Queue consumer without `max_batch_timeout`.

Correct: `max_batch_timeout = 0` on the consumer.

Cloudflare waits up to five seconds by default to fill a batch, and a wake
carries no data, so each wake waits for nothing.

Source: alandotcom/wfgraph:docs/embedding.md (Wake runs through a Queue)

## Completion

The deployment is done when these hold:

- A request to `/api/extensions` with a session answers `200`, and no
  invocation logs the `current_schema()` refusal.
- An Event posted to `/api/events` starts its runs within a minute without a
  Queue, or at once with one.
- A run with a short delay Wait completes within a minute after its deadline.
- The logs show one "Tick finished" or "Tick found nothing due" record per
  minute from the Cron Trigger.
