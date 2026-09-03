---
"@wfgraph/core": minor
"@wfgraph/client": minor
---

Add a Cancel Filter to each Cancel Event. The filter checks the arriving payload before cancellation and before the Correlation Path is required.

A declined or unevaluable filter leaves active runs unchanged and records why cancellation did not occur. Wait Subscriptions still receive the Event.

The Lifecycle panel and build agent support shared or per-Event Cancel Filters with the same condition editor used by Start Filters.

The release adds workflow audit indexes for efficient Refused Starts and Cancellation Failures queries. PostgreSQL deployments must run migrations. SQLite migrates on open.
