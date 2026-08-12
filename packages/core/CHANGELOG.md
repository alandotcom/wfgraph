# @wfgraph/core

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
