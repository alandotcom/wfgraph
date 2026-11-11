---
"@wfgraph/core": patch
---

Workflow names are now unique with their ASCII letters compared case-insensitively and every other character compared as written, on PostgreSQL as on SQLite. PostgreSQL used to fold letters by the database's own locale, so whether "Équipe" and "équipe" could coexist depended on how the database was created; they can now coexist on both backends.
