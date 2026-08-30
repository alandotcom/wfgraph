---
"@wfgraph/core": patch
---

PostgreSQL notices go through the configured logger instead of the console.

postgres.js hands a `NOTICE` to `console.log` unless it is given somewhere else to put one, so migrating printed raw objects to stdout: `schema "..." already exists, skipping` and `identifier "..." will be truncated`. A host that had configured logging still got them, in a shape nothing it configured chose, which is the arrangement ADR-0013 exists to avoid.

They are now a debug record on the `wfgraph.database` category, carrying the notice's code, severity and message. A host that configures no logging sees nothing, and one that does sees them only where it asked for debug.
