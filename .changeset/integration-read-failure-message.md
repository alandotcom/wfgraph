---
"@wfgraph/core": patch
---

A connection test or a configuration-options request whose connection cannot be read from the database now answers `Failed to read integration` and logs the database error on the server. The answer used to carry the database driver's own message, which can include query text and bound values.
