---
"@wfgraph/core": patch
---

Retry failed Event wake deliveries against saved Wait candidates. Candidate pages are captured before delivery, so a retry cannot wake a later Wait reached by an already-resumed branch.
