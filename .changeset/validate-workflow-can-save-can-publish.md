---
"@wfgraph/core": minor
---

`validate_workflow` now answers `canSave`, `saveIssues`, `canPublish`, `publishBlockers` and `warnings`. It answered `draftValid` and `structuralIssues`, and a client read `draftValid: true` beside publish blockers as "ready". `canPublish` is true only when the draft saves and has no publish blockers.
