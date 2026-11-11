---
"@wfgraph/core": minor
---

`@wfgraph/core` now exports the `WfGraphMcpOptions` and `WfGraphAgentConfig` types, which `WfGraphAppOptions` already named for its `mcp` and `agent` options, and `callExternal` and `callExternalAsync` with their `ExternalCallResult`, `ExternalError` and `ExternalRequest` types, which the integrations guide documents for a host action's HTTP calls and which were reachable only from `@wfgraph/core/plugin`.
