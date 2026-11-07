---
name: observability
description: >
  Use when sending an embedded Workflow Graph app's logs or traces somewhere:
  calling configureWfGraphLogging from @wfgraph/core/logging, passing the logger
  option to createWfGraphApp, createWfGraphRunner or wfWorker, adding a LogTape
  sink for the wfgraph category beside the host's own logging, registering an
  OpenTelemetry tracer provider, initialising Sentry, or building dashboards
  and alerts on Workflow Graph's span names and record fields. Also use for
  requests such as "the workflow engine logs nothing", "our own logs stopped
  after we added workflows", "show workflow runs in our tracing tool" or "the
  start-up warning says no sink receives the wfgraph category". For mounting
  the app and its other options use wfgraph-core.
metadata:
  purpose: >
    Configure Workflow Graph logging (configureWfGraphLogging, the logger option,
    the LogTape category wfgraph) and tracing (an OpenTelemetry provider, Sentry,
    and the stable span names).
  type: sub-skill
  library: wfgraph
  library_version: "3.1.1"
requires:
  - wfgraph-core
sources:
  - alandotcom/wfgraph:docs/embedding.md
  - alandotcom/wfgraph:packages/core/src/logging.ts
  - alandotcom/wfgraph:packages/core/src/backend/lib/log-config.ts
  - alandotcom/wfgraph:packages/core/src/backend/lib/telemetry.ts
---

This skill builds on wfgraph-core. Copy the three logging setups, the Sentry
setup and the OTLP provider from `docs/embedding.md` ("Logging", "Tracing",
"Sentry" and "Any other backend").

# Logging and tracing

Workflow Graph configures neither. It writes every log record through
[LogTape](https://logtape.org) under the `wfgraph` category, and opens every
span on the global `@opentelemetry/api` tracer provider under the
`wfgraph-workflows` instrumentation scope. Where records and spans go is the
host's decision. With nothing configured, records are dropped, start-up prints
one warning naming the three fixes, and spans are no-ops.

## Procedure

1. **Pick one logging setup for the process.** LogTape holds one configuration
   per process, so the choice depends on what the host already has:

   | The host already has                         | Do this                                                                                     |
   | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
   | No logging, or plain `console`               | Call `configureWfGraphLogging()` from `@wfgraph/core/logging` before `createWfGraphApp`     |
   | A logger that is not LogTape (pino, winston) | Pass it as the `logger` option: an object with `info`, `warn`, `error` and optional `debug` |
   | Its own LogTape `configure` call             | Add `{ category: "wfgraph", sinks: [...], lowestLevel: "info" }` to its `loggers` list      |

   Result: start-up prints no warning about the `wfgraph` category, and a
   record "Extension surface assembled" arrives under `wfgraph.extensions`.

2. **Repeat it in every process.** `createWfGraphRunner` and `wfWorker` take
   the same `logger` option and warn the same way. `migrateWfGraphDatabase`
   logs under `wfgraph` too, so a migration job sets logging up first.
   Result: the runner's "Worker loop stopped" record and the migration job's
   records reach the same place as the app's.
3. **Register a tracer provider on the global API.** Either call `register()`
   on the `NodeTracerProvider` the manual builds, call
   `trace.setGlobalTracerProvider(provider)` from `@opentelemetry/api`, or call
   `Sentry.init` from `@sentry/node`, which registers Sentry's provider.
   Workflow Graph resolves the provider once per span, so registering before or
   after `createWfGraphApp` both work. Result: each pass of a run exports one
   `wfgraph.workflow.execution` span.
4. **Build dashboards on the stable names.** Use the span names and attributes
   listed in Core Patterns and the record groups, never message text or an
   internal span name.

## Core Patterns

### configureWfGraphLogging

It writes to the console. `level` and `format` options, or the `LOG_LEVEL`
(default `info`) and `LOG_FORMAT` (`pretty` or `json`) variables, choose the
output; with neither format set, a terminal gets `pretty` and a pipe gets one
JSON object per line. `LOG_PRETTY_PROPERTIES`, `LOG_PRETTY_INSPECT_DEPTH`,
`LOG_PRETTY_WIDTH` and `NO_COLOR` tune the pretty layout. Calling it again
replaces the configuration.

### What a record holds

One record covers one unit of work: one HTTP request, one node execution, the
start and the end of one pass of a run. Fields are grouped by subject (`http`,
`rpc`, `run`, `node`, `outcome`, `error`). A JSON line keeps each group as a
nested object, so a log store queries `http.status` or `run.execution`. No
record carries a request body, a response body, an Event payload or a step
output.

### Stable span names

All arrive under the `wfgraph-workflows` scope. The engine opens four per run:

| Span                              | Opened for               | Attributes                                                                                           |
| --------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `wfgraph.workflow.execution`      | one pass of a run        | `wfgraph.workflow.id`, `wfgraph.workflow.name`, `wfgraph.execution.id`, `wfgraph.execution.run_mode` |
| `wfgraph.workflow.node.execute`   | each node                | `wfgraph.node.id`, `wfgraph.node.name`, `wfgraph.node.type`, and `wfgraph.action.type` on an action  |
| `wfgraph.workflow.action.execute` | the action inside a node | `wfgraph.action.type`, `wfgraph.node.id`, `wfgraph.node.name`                                        |
| `wfgraph.workflow.wait`           | a Wait node              | `wfgraph.wait.type` (`delay` or `event`), `wfgraph.node.id`, `wfgraph.node.name`                     |

Twelve service spans, such as `wfgraph.workflow.publish` and
`wfgraph.execution.cancel`, are also stable and carry `wfgraph.outcome` where a
call has a verdict; the manual's table lists them. Any other span is named
after an internal function and changes with the code. Every attribute is an
identifier or one outcome word.

### A Wait ends the trace

A run executes in passes, and a pass ends when every branch has finished or
parked at a Wait. Each pass opens a root `wfgraph.workflow.execution` span of
its own, so one run with a Wait appears as several traces. Join them on
`wfgraph.execution.id`.

### Sentry

`Sentry.init` is the whole trace setup. To put log records on the same trace,
add `getSentrySink()` from `@logtape/sentry` as the `wfgraph` sink in the
host's own LogTape configuration (the third setup), with a console sink beside
it to keep reading records locally.

## Common Mistakes

### HIGH A LogTape configuration with no wfgraph sink

Wrong: `configure({ sinks: { console }, loggers: [{ category: "my-app", sinks: ["console"] }] })`.

Correct: add `{ category: "wfgraph", sinks: ["console"], lowestLevel: "info" }`
to the same `loggers` list.

Workflow Graph's records have no sink and are dropped. Start-up prints one
warning that names the `wfgraph` category, and nothing else says so.

Source: alandotcom/wfgraph:docs/embedding.md (Logging)

### HIGH A second LogTape configuration

Wrong: a host with its own LogTape `configure` call also passes `logger` to
`createWfGraphApp`, or also calls `configureWfGraphLogging()`.

Correct: keep the host's configuration and add a `wfgraph` logger entry to it.

The `logger` option and `configureWfGraphLogging` each install a LogTape
configuration and replace any other in the process, so the host's own
categories stop reaching their sinks.

Source: alandotcom/wfgraph:docs/embedding.md (Logging)

### HIGH A tracer provider that is never registered

Wrong: `new NodeTracerProvider({ spanProcessors: [processor] })` with no
`register()` call, or a provider handed to Workflow Graph some other way.

Correct: `provider.register()`, or `trace.setGlobalTracerProvider(provider)`.

Workflow Graph takes no provider option and reads only the global API, so its
spans stay no-ops and the exporter receives nothing.

Source: alandotcom/wfgraph:docs/embedding.md (Tracing)

### MEDIUM One trace per run

Wrong: an alert or dashboard that expects a whole run, Waits included, under
one trace id.

Correct: group the pass spans by `wfgraph.execution.id`.

Nothing carries trace context from one pass to the next, so each pass after a
Wait starts a new trace.

Source: alandotcom/wfgraph:docs/embedding.md (Tracing)

## Completion

Logging and tracing are done when these hold in each process:

- Start-up prints no warning about the `wfgraph` category, and the host's own
  log categories still arrive where they did before.
- A request to the API produces one record under `wfgraph.http` with an `http`
  group holding its method, path and status.
- Starting a workflow by hand produces a `wfgraph.workflow.execution` span
  under the `wfgraph-workflows` scope whose `wfgraph.execution.id` matches the
  run, with a `wfgraph.workflow.node.execute` span for each node.
