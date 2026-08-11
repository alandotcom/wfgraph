---
"@wfgraph/core": minor
---

Add pluggable persistence backends for PostgreSQL, native Node SQLite, and Cloudflare
Hyperdrive. Configure a Node app with `wfPostgres` or `wfSqlite`, and configure a
Cloudflare Worker with `wfHyperdrive` and `wfWorker`.

This replaces `createWfGraphApp`'s PostgreSQL-specific `database` option with the
backend-independent `persistence` option. Calling `wfSqlite()` creates an ephemeral
in-memory database; pass `filename` to persist it to a file.
