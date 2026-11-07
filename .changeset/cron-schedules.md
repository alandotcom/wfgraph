---
"@wfgraph/core": minor
"@wfgraph/client": minor
---

A workflow's Lifecycle Rules can hold cron schedules that start runs. Each schedule is a 5-field cron expression read in an IANA time zone, and a workflow can hold several. A save refuses a schedule on a workflow that tracks an Entity, and Publish refuses one on a graph with an Event Split.

Publishing a version that declares schedules writes one timer per schedule, due at the schedule's first time after the Publish. The database executor fires a timer when it falls due: it starts a run of the published version with no payload, as a manual run naming no Event would start, and moves the timer to the schedule's next time. A timer claimed late, such as after the workers were down, fires once, for the most recent time it missed. Concurrency treats every scheduled run as being about the workflow itself, so first-wins records a Refused Start for a fire while a run is going and newest-wins supersedes that run. Pausing a workflow deletes its timers and resuming writes them again, due at each schedule's first time after the resume, so a paused workflow skips the times it was paused through. Republishing keeps the timer of an unchanged schedule, and a draft never fires.

The worker loop and a Worker's Cron Trigger tick claim timers in a lane of their own with one slot, so a host needs no new setting. On PostgreSQL that lane's pass shares the pool with the others, so a loop at its defaults can hold one more connection than before.

A slot that does not run shows in the Runs view's Refused Starts. When the published version no longer passes the checks a run starts with, or a fire fails on every retry, the slot is skipped with a Refused Start written in the same transaction that moves the timer on, under the reasons `published_version_not_runnable` and `scheduled_start_failed`. A scheduled run's Refused Start names the slot's time in the schedule's zone, as in "Refused the 9:00 AM scheduled run: a run is still going and Concurrency is first-wins".

Both run lists and a run's logs carry `scheduledFor`, the ISO timestamp of the time a scheduled run fired for, and `scheduleDescription`, the schedule that started it in words, such as "Every weekday at 9:00 AM (America/New_York)". Both are null for a run no schedule started.

Migrations on both backends add `workflow_id`, `cron` and `time_zone` to `workflow_execution_schedule`, with a unique index on the three. They add the nullable `scheduled_for`, `schedule_cron` and `schedule_time_zone` to `workflow_executions`, which a fire writes with its slot and schedule, and a check holds `schedule_cron` and `schedule_time_zone` to both or neither, on a scheduled run alone.

The Lifecycle editor gains a Schedule section. A Workflow Builder adds a schedule from a preset (Every hour, Every day at, Every weekday at, Every week on) or as a custom cron expression, and picks its time zone, which starts from the browser's own. Each schedule reads back as a sentence with its next three runs. An edit a save would refuse, such as an invalid expression or a duplicate schedule, stays in the section unsaved beside the refusal. The Lifecycle summary lists each schedule with its next run, and the Lifecycle node on the canvas counts its schedules.

The Runs view titles a scheduled run "Scheduled run" in the run list, the run's overview and the All Runs page, and shows the schedule's description as the line beneath the title, in a Schedule row of the overview, and under the workflow's name on the All Runs page. When a scheduled run started more than a minute after the time it was scheduled for, the overview shows a Scheduled row with that time above the Started row.

The build agent's `set_lifecycle_rules` tool takes `schedules` for the complete set, or `addSchedules` and `removeSchedules` to change the stored ones. It refuses an invalid expression, an unknown time zone, a duplicate, or a schedule on a workflow that tracks an Entity, with the reason a save would give.
