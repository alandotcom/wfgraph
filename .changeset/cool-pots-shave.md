---
"@wfgraph/core": minor
---

The host configures logging, and a log record is one unit of work.

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
