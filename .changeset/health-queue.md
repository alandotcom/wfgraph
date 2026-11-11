---
"@wfgraph/core": minor
---

`app.health()` now also answers `queue`: how many runs, Event deliveries and cron fires are due now across every process's loops, the earliest wake time among them, and how long that row has waited, for a host to export as a metric. The readiness route leaves it out, since it answers without authentication. `WfGraphQueueHealth` is exported.
