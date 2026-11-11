---
"@wfgraph/core": minor
---

The MCP catalog tools (`list_actions`, `describe_action`, `list_events`, `describe_event`, `list_integrations`) no longer require a `workflowId` or the `workflow.getById` grant, so a client can discover what the host offers before it creates a workflow. `list_integrations` still requires `integration.getAll`.
