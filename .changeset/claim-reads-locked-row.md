---
"@wfgraph/core": patch
---

On PostgreSQL, a claim no longer counts a failure against a run whose pass released it in the moment between the claim's read and its lock. The claim now reads each row as it locks it.
