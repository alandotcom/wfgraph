---
"@wfgraph/core": patch
---

A start that PostgreSQL aborted for a serialization conflict is retried again, rather than failing its node.

`startForEntity` opens a run inside a SERIALIZABLE transaction, because the in-flight read and the insert have to be one decision. PostgreSQL answers two starts that race for the same entity by aborting one with SQLSTATE 40001, which the repository is meant to retry.

The check that recognised the abort read `error.cause` alone. Drizzle wraps a driver failure in a `DrizzleQueryError` carrying the SQL it ran, so the `PostgresError` holding the SQLSTATE sits one level further down and the code was never found. Every aborted start therefore surfaced as a database failure. The check now walks the cause chain, and an unrelated failure is still reported rather than retried.

This only ever affected PostgreSQL under concurrent starts for one entity value. SQLite serializes writes with `BEGIN IMMEDIATE` and raises no such code.
