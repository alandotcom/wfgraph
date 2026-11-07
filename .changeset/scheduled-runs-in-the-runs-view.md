---
"@wfgraph/core": minor
"@wfgraph/client": minor
---

Both run lists and a run's logs now carry `scheduledFor`, the ISO timestamp of the time a scheduled run fired for, or null for a run no schedule started.

The Runs view titles a scheduled run "Scheduled run" in the run list, the run's overview and the All Runs page, where it showed the workflow's own Entity Value, `workflow:<id>`. When a scheduled run started more than a minute after the time it was scheduled for, the overview shows a Scheduled row with that time above the Started row.

A schedule's slot that does not run now shows in the Runs view's Refused Starts. When the published version no longer passes the checks a run starts with, or a fire fails on every retry, the slot is skipped with a Refused Start written in the same transaction that moves the timer on, under the new reasons `published_version_not_runnable` and `scheduled_start_failed`. A scheduled run's Refused Start names the slot's time in the schedule's zone, as in "Refused the 9:00 AM scheduled run: a run is still going and Concurrency is first-wins".
