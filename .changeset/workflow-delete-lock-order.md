---
"@wfgraph/core": patch
---

On PostgreSQL, deleting a workflow while a worker is running one of its runs no longer fails with a deadlock. The delete now locks the runs' schedule rows and then the runs, in the order a worker's write takes them, and waits for the worker's write to commit.
