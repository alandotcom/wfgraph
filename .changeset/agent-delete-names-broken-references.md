---
"@wfgraph/core": patch
---

`delete_node` and `disconnect_nodes` now name every step the removal left holding a reference it can no longer read, in the editor's build agent and over MCP, rather than reporting success alone.
