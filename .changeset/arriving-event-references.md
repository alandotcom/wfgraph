---
"@wfgraph/core": minor
---

Tell the build agent when an Event wait changes what the steps below it can read.

An event-mode Wait becomes the Arriving Event for everything below it, so the Lifecycle Node there carries the waited-for payload and the Start Event payload is gone. Nothing said so, and a caller that had already collected a token could write it into a step that can no longer resolve it, with Publish the next thing to notice.

`list_references` now returns `declaredBy` on every Lifecycle Node reference, naming the Events the path came from, and marks those references nullable below a Wait that continues past its timeout, since a timed-out run arrives with no payload at all. `set_wait` and `set_lifecycle_rules` return a `warning` listing the config values their edit just stranded. The refusal for an unreadable until-timing token now names the Wait that took the payload away instead of pointing back at `list_references`.
