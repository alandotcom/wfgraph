# @wfgraph/core

## 2.0.0

### Major Changes

- [#99](https://github.com/alandotcom/wfgraph/pull/99) [`ff1d523`](https://github.com/alandotcom/wfgraph/commit/ff1d52354079abad1d265c0a27ab27395a1bc177) Thanks [@alandotcom](https://github.com/alandotcom)! - Take `inngest` and `hono` as peer dependencies rather than dependencies. Add both to your
  own manifest alongside `@wfgraph/core`:

  ```bash
  pnpm add @wfgraph/core inngest hono
  ```

  Your application now owns the version of each that runs in its process, inside `^4.18.0`
  for `inngest` and `^4.13.1` for `hono`. For Inngest that is the point of the change: a host
  that already drives Inngest functions of its own used to end up with a second copy of a
  durable-execution runtime, carrying its own OpenTelemetry stack, protobuf codec and Connect
  worker, as a silent outcome of an install. A version disagreement now fails at install,
  where it can be read.

  Nothing about the API moved. `createWfGraphApp` still takes the same `inngest` config object
  and still builds its own Inngest client and its own Hono app, and it still answers with
  `fetch`, `basePath` and `dispose`. Neither library appears in what it hands back, and no
  published type names either one.

### Minor Changes

- [#98](https://github.com/alandotcom/wfgraph/pull/98) [`1c94924`](https://github.com/alandotcom/wfgraph/commit/1c9492471ae3d5e70b09bb29beab5f686468ff90) Thanks [@alandotcom](https://github.com/alandotcom)! - Name a run and its steps in the Inngest UI.

  Every workflow executes on one Inngest function, so the dashboard labelled every
  run "Workflow run" and every trace row carried a memoization id built from an
  opaque node id. Two things change that:

  - A run attaches its own identity as Inngest run metadata under the
    `userland.wfgraph` kind: the workflow's name and id, the execution id, the run
    mode, the triggering event, the workflow version and the node count, plus the
    entry node on a branch run. It is written inside one memoized step, so it
    survives a replay and costs no extra request. A refused write is logged and
    the run continues.
  - Each durable step now carries a display name beside its id, so a trace reads
    `Post to Slack: post` rather than `node:vMVCWuW-OmRDEhJok5pfu:post`. Every step
    id is unchanged, so memoization behaves exactly as before.

  The Inngest client is now built with `metadataMiddleware()` from
  `inngest/experimental`, which is what makes the metadata surface reachable. The
  Inngest Dev Server shows the Metadata tab from v1.17.0.

## 1.0.0

## 0.3.0

### Minor Changes

- [#91](https://github.com/alandotcom/wfgraph/pull/91) [`5c9a259`](https://github.com/alandotcom/wfgraph/commit/5c9a259a886494cb711fd4d747adbebe2c7dc44f) Thanks [@alandotcom](https://github.com/alandotcom)! - Effect moves to the 4.0 release candidate.

  `effect`, `@effect/vitest` and `@effect/opentelemetry` go from `4.0.0-beta.102` to
  `4.0.0-rc.108`, so an adopter installing `@wfgraph/core` or `@wfgraph/plugins` resolves the
  release candidate. Upstream treats the 4.0 interfaces as final from this version on.

  Two upstream changes are visible here. `Schema.TaggedErrorClass` is now `Schema.TaggedError`,
  which is how every failure type in the backend is declared. Separately, a `SchemaIssue` has
  stopped carrying the value a decode rejected, and holds it only when the decode asks with
  `reportInput`. Workflow Graph asks nowhere, so a message about a refused step config, Event
  payload, step output or workflow graph ends after the field path and the expectation. Where
  one read `to: Expected string, got 7`, it now reads `to: Expected string`.

  `formatSchemaFailurePaths` is gone from `@wfgraph/shared`. `formatSchemaFailure` renders
  what it used to render, so one function now covers both audiences.

  A failed check keeps the bound Effect names for it, so `name: Invalid value` reads
  `name: Expected a value with a length of at least 1`.

## 0.2.0

### Minor Changes

- [#89](https://github.com/alandotcom/wfgraph/pull/89) [`d8c6b96`](https://github.com/alandotcom/wfgraph/commit/d8c6b968fb029509bcdb12587fc7bbda354ed9c3) Thanks [@alandotcom](https://github.com/alandotcom)! - The host configures logging, and a log record is one unit of work.

  `@wfgraph/core` no longer calls LogTape's `configure` for you. It asks for a logger under
  the `wfgraph` category and leaves the sinks, the levels and the format to the application.
  An app that installs nothing gets no output, and `createWfGraphApp` prints one notice at
  start-up naming the three ways to fix it:

  - `configureWfGraphLogging()` from the new `@wfgraph/core/logging` entry, which installs
    the console setup Workflow Graph used to install for you.
  - The `logger` option, unchanged.
  - Your own LogTape configuration with a sink for the `wfgraph` category.

  `@wfgraph/core/migrate` writes through the same category, so a migration job that wants
  its output calls one of the three first.

  What the output looks like has changed with it. The category root is `wfgraph` rather than
  `app`, and each category is one level deep. One HTTP request writes one record naming the
  method, the path, the status, the elapsed time, the procedure it addressed and the reason
  it was refused; request and response bodies are no longer logged at all. One node
  execution writes one record rather than the four to six the engine used to narrate. A
  record's fields arrive grouped by subject (`http`, `rpc`, `run`, `node`, `outcome`,
  `error`). The default level in development is `info` rather than `debug`.

## 0.1.0

### Minor Changes

- [#86](https://github.com/alandotcom/wfgraph/pull/86) [`863b6a3`](https://github.com/alandotcom/wfgraph/commit/863b6a3dcbfb963dab022e646bfa4b6e380a099e) Thanks [@alandotcom](https://github.com/alandotcom)! - Add pluggable persistence backends for PostgreSQL, native Node SQLite, and Cloudflare
  Hyperdrive. Configure a Node app with `wfPostgres` or `wfSqlite`, and configure a
  Cloudflare Worker with `wfHyperdrive` and `wfWorker`.

  This replaces `createWfGraphApp`'s PostgreSQL-specific `database` option with the
  backend-independent `persistence` option. Calling `wfSqlite()` creates an ephemeral
  in-memory database; pass `filename` to persist it to a file.

## 0.0.2

### Patch Changes

- [#84](https://github.com/alandotcom/wfgraph/pull/84) [`33a616f`](https://github.com/alandotcom/wfgraph/commit/33a616f4118adb125f578627a21310a1ca24912f) Thanks [@alandotcom](https://github.com/alandotcom)! - Each package now ships its own README, so its npm page describes what it is rather than
  offering to let someone add one, and declares `engines.node` at the Node 24 floor the repo
  already builds against, so an install on an older runtime warns instead of failing later.

## 0.0.1

### Patch Changes

- First published release. `@wfgraph/core` carries the run engine, the authoring
  vocabulary and `createWfGraphApp`; `@wfgraph/client` carries the editor bundle a
  host hands it; `@wfgraph/plugins` carries the six built-in integrations.
