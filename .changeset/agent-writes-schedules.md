---
"@wfgraph/core": minor
---

The build agent can write cron schedules. Its `set_lifecycle_rules` tool takes `schedules` for the complete set, or `addSchedules` and `removeSchedules` to change the stored ones, and refuses an invalid expression, an unknown time zone, a duplicate, or a schedule on a workflow that tracks an Entity, with the reason a save would give.
