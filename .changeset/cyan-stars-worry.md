---
"@wfgraph/core": patch
---

Refuse an execution migration when its parked Waits have changed since eligibility was checked. Serialize PostgreSQL repark writes with migration so an old-version park cannot overwrite the migrated state.
