---
"@wfgraph/core": minor
"@wfgraph/client": minor
---

Both run lists and a run's logs now carry `scheduledFor`, the ISO timestamp of the time a scheduled run fired for, and `scheduleDescription`, the schedule that started it in words, such as "Every weekday at 9:00 AM (America/New_York)". Both are null for a run no schedule started. Migrations on both backends add the nullable `schedule_cron` and `schedule_time_zone` to `workflow_executions`, which a fire writes with the schedule it fired, and a check holds them to both or neither, on a scheduled run alone.

The Runs view titles a scheduled run "Scheduled run" in the run list, the run's overview and the All Runs page, where it showed the workflow's own Entity Value, `workflow:<id>`, and shows the schedule's description as the line beneath the title, in a Schedule row of the overview, and under the workflow's name on the All Runs page. When a scheduled run started more than a minute after the time it was scheduled for, the overview shows a Scheduled row with that time above the Started row.

A schedule's slot that does not run now shows in the Runs view's Refused Starts. When the published version no longer passes the checks a run starts with, or a fire fails on every retry, the slot is skipped with a Refused Start written in the same transaction that moves the timer on, under the new reasons `published_version_not_runnable` and `scheduled_start_failed`. A scheduled run's Refused Start names the slot's time in the schedule's zone, as in "Refused the 9:00 AM scheduled run: a run is still going and Concurrency is first-wins".
