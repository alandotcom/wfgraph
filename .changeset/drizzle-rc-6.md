---
"@wfgraph/core": patch
---

`@wfgraph/core` depends on `drizzle-orm` 1.0.0-rc.6. The native SQLite backend decodes its `count(*)`, `min(...)` and flag expressions as numbers, since rc.6 returns integer SQL expressions without a decoder as `bigint` on `node:sqlite`.
