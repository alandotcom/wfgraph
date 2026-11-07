---
"@wfgraph/core": minor
---

A cron schedule in a workflow's Lifecycle Rules now starts runs. Publishing a version that declares schedules writes one timer per schedule, due at the schedule's first time after the Publish, and the database executor fires each timer when it falls due: it starts a run of the published version with no payload, as a manual run naming no Event would start, and moves the timer to the schedule's next time. A timer claimed late, such as after the workers were down, fires once, for the most recent time it missed. Concurrency treats every scheduled run as being about the workflow itself, so first-wins records a Refused Start for a fire while a run is going and newest-wins supersedes that run. Pausing a workflow deletes its timers and resuming writes them again, due at each schedule's first time after the resume, so a paused workflow skips the times it was paused through. Republishing keeps the timer of an unchanged schedule, and a draft never fires.

The worker loop and a Worker's Cron Trigger tick claim timers in a lane of their own with one slot, so a host needs no new setting. Migrations on both backends add `workflow_id`, `cron` and `time_zone` to `workflow_execution_schedule`, with a unique index on the three, and a nullable `scheduled_for` to `workflow_executions`, which records the time a scheduled run fired for.
