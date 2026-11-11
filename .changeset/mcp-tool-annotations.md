---
"@wfgraph/core": patch
---

Every MCP tool now carries a `title` and states all four behaviour hints. Read tools are read-only and idempotent, `delete_node` and `disconnect_nodes` are destructive, and every tool sets `openWorldHint: false`. Before this, an unset `destructiveHint` and `openWorldHint` read as destructive and open-world under the specification's defaults.
