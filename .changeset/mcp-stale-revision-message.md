---
"@wfgraph/core": patch
---

A stale MCP write (`workflow_draft_stale`) now says whether the draft moved on since the client's revision or the client sent a revision ahead of the stored one, states that nothing was written, and names `read_workflow` as the read that recovers.
