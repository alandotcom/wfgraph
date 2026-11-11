---
"@wfgraph/core": patch
---

A resend that reopens a failed Event delivery no longer decides a refused start again. A start the first delivery refused through a Start Filter, first-wins Concurrency or a missing Entity Value is answered from its Refused Start row, so the resend cannot open a run the first delivery declined.
