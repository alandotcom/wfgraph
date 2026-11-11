---
"@wfgraph/core": patch
---

Deleting all of a workflow's runs, and deleting a workflow, now remove its run history 500 rows per transaction. Each used to be one transaction over the whole history, which on SQLite held the database's only writer until it finished. A delete that stops partway leaves whole runs behind, and repeating it deletes the rest.
