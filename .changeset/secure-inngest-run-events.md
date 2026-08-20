---
"@wfgraph/core": patch
---

Load workflow run inputs from the persisted execution and published version instead of trusting Inngest event payloads. Refuse terminal executions, and make workflow-branch invoke-only with the same persisted reload.
