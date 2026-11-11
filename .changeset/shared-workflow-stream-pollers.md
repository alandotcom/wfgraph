---
"@wfgraph/core": patch
---

The workflow-list and draft-revision subscriptions now share one database poller per process: one for the list and one for each subscribed workflow, started by the first subscriber and stopped after the last one leaves. Each open editor tab used to run its own pollers, each reading the whole workflow list every 500 ms.
