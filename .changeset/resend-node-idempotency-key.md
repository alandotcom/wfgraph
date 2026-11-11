---
"@wfgraph/plugins": patch
---

Resend's Send Email sends an idempotency key that names its node within the run. Two Send Email nodes in one run used to share the run's id as their key, so Resend answered the second node with the first node's email and sent nothing.
