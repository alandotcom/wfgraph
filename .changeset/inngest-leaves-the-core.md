---
"@wfgraph/core": major
---

Workflow runs and Event deliveries now execute in your own process, on a worker loop that keeps its state in the `persistence` database. Inngest is no longer required.

- **Runs.** `createWfGraphApp` starts the worker loop. Tune it with the `runner` option, or pass `runner: false` and run the loop in a separate process with `createWfGraphRunner` (PostgreSQL only).
- **Events.** Every Event arrives in the `workflow_event_inbox` table, and the worker loop delivers it. Send one with `app.events.send({ name, data, id? })` (also on the runner), with `POST {basePath}/api/events` and an `Authorization: Bearer` key once you set `events: { key }`, through a Connection's webhook, or by inserting a row inside your own database transaction (the SQL contract in `docs/events.md`). `id` is the idempotency key. Settled rows are kept for `events.retentionMs`, seven days by default, which is also the deduplication window.
- **Inngest is optional.** `inngest` is now an optional peer dependency. To keep `inngest.send`, install `inngest` and register `createWfGraphInngestFunctions({ client, extensions, app })` from the new `@wfgraph/core/inngest` entry with your own Inngest `serve` or `connect`. Each forwarder sends the Inngest event into the inbox through `app.events.send`.
- **Removed.** The `inngest` option on `createWfGraphApp` and on the Worker entry's request config (so `WfGraphInngestConfig` is gone), the `/api/inngest` route, Workflow Graph's own Inngest client, Connect handling and signing-key checks, `defineEvent`'s `inngest` option, `workflowRunId` on execution records, and `runId` on a started run.
- **Before you upgrade, drain in-flight runs.** A run Inngest was holding has no row for the worker loop to claim, so it never advances. Let each one finish, or cancel it, first.
