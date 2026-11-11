---
"@wfgraph/core": patch
---

A build agent turn now applies to each tool the grants the MCP endpoint applies: `workflow.getById` for every tool, `workflow.update` for a write tool, and `integration.getAll` for `list_integrations`. A caller holding `agent.use` without `integration.getAll` could read the operator's Connection ids and types through the chat; that tool now answers the model a refusal for them.
