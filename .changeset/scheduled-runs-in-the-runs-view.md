---
"@wfgraph/core": minor
"@wfgraph/client": minor
---

Both run lists and a run's logs now carry `scheduledFor`, the ISO timestamp of the time a scheduled run fired for, or null for a run no schedule started.

The Runs view titles a scheduled run "Scheduled run" in the run list, the run's overview and the All Runs page, where it showed the workflow's own Entity Value, `workflow:<id>`. When a scheduled run started more than a minute after the time it was scheduled for, the overview shows a Scheduled row with that time above the Started row.
