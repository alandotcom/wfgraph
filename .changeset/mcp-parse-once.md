---
"@wfgraph/core": patch
---

The MCP endpoint reads and parses each request body once, and builds its tool schemas once per process rather than on every request. A tool call whose arguments hold more than 10,000 array elements and object members is now refused as a tool error before validation.
