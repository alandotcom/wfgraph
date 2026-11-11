---
"@wfgraph/core": patch
---

A Cancel Event and Concurrency now reach the runs an older published version started after a Publish that began or stopped tracking an Entity. Those runs keep the identity form their version started them with, the Entity Value or the typed Entity identity, and an arriving Event is compared with them in that form, where before such runs could no longer be cancelled or superseded.
