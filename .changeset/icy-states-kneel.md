---
"@wfgraph/core": patch
---

Preserve a Wait's row, token, and deadline when preparation retries after a committed database write. Retried preparation and migration keep recorded arrivals available for recovery.
