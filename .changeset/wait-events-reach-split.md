---
"@wfgraph/core": patch
---

An event-mode Wait is an Arriving Event source.

`eventsReaching` now hands on the Events a Wait parks on, so an Event Split below it offers those Events rather than the Start Events that put the run at the Wait. The engine routes on the Event that woke the Wait, and the entry node's output becomes that payload, matching a Cancel Event. A timeout that continues names no Arriving Event, so an Event Split below the Wait stops rather than taking a Start Event outlet.
