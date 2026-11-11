---
"@wfgraph/core": minor
---

An event-mode Wait no longer misses an Event that was delivered while its run was still on the way to it. When the Wait first parks, it wakes at once with the oldest Event its subscription and match accept that was delivered since the run started. The Event that started the run, the Cancel Event that claimed it, and an Event that already woke one of the run's Waits never count.
