---
"@wfgraph/core": patch
---

A delivery now applies the Lifecycle Rules and wakes the Waits of the workflows an Event concerns side by side, up to ten workflows at once, so one workflow whose Entity resolver is slow no longer delays the others.
