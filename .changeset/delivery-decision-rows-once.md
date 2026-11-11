---
"@wfgraph/core": patch
---

A delivery that runs a lifecycle step again, after a crash or a resend of a failed Event, no longer writes its Refused Start or Cancellation Failure row twice. Each such row is written under an id derived from the workflow and the delivery, so the repeat is a no-op.
