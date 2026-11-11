---
"@wfgraph/core": patch
---

Delivering an Event to a workflow with many runs parked on it no longer reads and sorts every parked run of that workflow for each page of 200. The index over a workflow's waiting rows now carries the row id, so each page starts where the last one ended, on PostgreSQL and on SQLite.
