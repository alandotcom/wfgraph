---
"@wfgraph/core": patch
---

Keep workflow lists current through an authenticated server-sent events subscription. The editor pauses the subscription in hidden tabs and refreshes the shared workflow-list query cache when the server reports a change. Worker deployments keep request-scoped persistence open until a streaming response ends.
