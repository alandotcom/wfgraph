---
"@wfgraph/core": patch
---

On SQLite, the event inbox retention sweep now reads its settled-row index. It used to scan and sort the whole inbox on every sweep while holding the database's write lock.
