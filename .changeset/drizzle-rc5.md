---
"@wfgraph/core": patch
---

Update drizzle-orm and drizzle-kit from 1.0.0-rc.4 to 1.0.0-rc.5.

rc5 ships the `Schema.TaggedError` fix that the local drizzle-orm patch carried, so the patch is gone. The postgres-js driver now serializes JSON parameters itself, so the two Wait-state metadata merges pass their objects as parameters where they previously passed a `JSON.stringify` result. The PostgreSQL migration snapshots are rewritten in drizzle-kit's incremental format; the migration SQL and journal hashes are unchanged.
