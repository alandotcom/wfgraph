---
"@wfgraph/client": patch
---

A graph edit whose save failed is no longer lost when the editor opens another workflow. The editor holds the edit, sends it again after a backoff and when the browser comes back online, and restores it on the canvas with its failure when the workflow is opened again. The resend expects the draft revision the edit was written against, so a draft saved elsewhere in the meantime is reported as a conflict and is never overwritten.
