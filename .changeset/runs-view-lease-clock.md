---
"@wfgraph/core": patch
---

On PostgreSQL, the Runs view and the host health check read a run's lease on the same clock the executor keeps it on. A process whose clock runs ahead of the database's no longer shows a live run as Stalled, and the health check no longer counts its lease as due.
