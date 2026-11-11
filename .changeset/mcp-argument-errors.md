---
"@wfgraph/core": minor
---

An MCP `tools/call` whose arguments do not match the tool's schema now returns an `isError` tool result naming each wrong field and what it expected, in place of JSON-RPC error `-32602` "Invalid tool arguments" with HTTP 400. The MCP specification classes input validation errors as tool execution errors so a model can correct the call. A call naming an unknown tool still answers `-32602`.
