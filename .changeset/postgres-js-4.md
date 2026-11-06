---
"@wfgraph/core": patch
---

The PostgreSQL backends (`@wfgraph/core/postgres`, the Hyperdrive backend in `@wfgraph/core/worker`, and `@wfgraph/core/migrate`) now run on `postgres` (Postgres.js) `^4.1.0`, up from `^3.4.9`. Workflow Graph's queries go through Drizzle, which keeps reading and writing its `timestamp` columns as UTC, so stored runs, versions and waits read back unchanged. A transaction the server answers with `ROLLBACK` at `COMMIT` now rejects instead of resolving. The startup log line leaves out the database and user fields when Postgres.js has no string for them, which happens only for a user given as a function.
