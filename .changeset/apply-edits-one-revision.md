---
"@wfgraph/core": patch
---

A build-agent `apply_edits` call is now one draft revision in the chat panel, as it already was over MCP. It advanced the turn's revision once per operation, and a refused batch left revisions behind for the edits it undid.
