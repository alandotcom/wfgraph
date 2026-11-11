---
"@wfgraph/core": patch
---

On PostgreSQL, paging through the Runs view's list of runs across every workflow no longer skips a run that started in the same millisecond as the last run of the previous page. A run's start time is now written from the process clock at millisecond precision, the precision the page cursor carries, and a run's duration is measured on that same clock. One workflow's run list now orders runs that started in the same instant by id, as it already did on SQLite.
