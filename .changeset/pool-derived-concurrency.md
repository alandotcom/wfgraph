---
"@wfgraph/core": minor
---

The worker loop's default run concurrency on PostgreSQL now follows the pool size: `min(10, max(1, floor(maxConnections / 2)))`, which is 5 for the default pool of 10, where it used to take the whole pool. At the old default a loop could hold 12 connections from a pool of 10 once its delivery and cron lanes ran beside its runs, leaving the app's HTTP requests queued behind them. A `runner.concurrency` the host sets is used as it is.
