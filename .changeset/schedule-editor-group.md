---
"@wfgraph/client": minor
---

The Lifecycle editor gains a Schedule section. A Workflow Builder adds a schedule from a preset (Every hour, Every day at, Every weekday at, Every week on) or as a custom 5-field cron expression, and picks its IANA time zone, which starts from the browser's own. Each schedule reads back as a sentence with its next three runs, and a workflow can hold several. An edit a save would refuse, such as an invalid expression or a duplicate schedule, stays in the section unsaved beside the refusal. The Lifecycle summary lists each schedule with its next run, and the Lifecycle node on the canvas counts its schedules.
