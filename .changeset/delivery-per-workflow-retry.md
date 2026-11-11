---
"@wfgraph/core": patch
---

A delivery whose step keeps failing for one workflow, such as one whose Entity resolver times out, no longer keeps the Event from the other workflows it concerns. Each workflow's steps are retried on their own, the other workflows are started, cancelled and woken on the first pass, and once the retries are spent the failing workflow alone is recorded: a `run_refused` or `cancel_not_delivered` audit row with `reason: "delivery_failed"`. The inbox row then settles `failed` with an error that counts the workflows the Event reached and names each one that failed, and a resend of its key delivers it again.
