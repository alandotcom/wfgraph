---
"@wfgraph/core": minor
---

Give the build agent a way to undo a turn.

`revert_draft` puts the graph back as it was when the turn began. Nothing could undo an edit before, which is why the agent was told to finish all capability discovery before its first write: an unavailable capability had to leave the graph untouched, and that promise is unkeepable once anything has been written. With an undo the promise is keepable after a write, so the ordering rule is gone. Discovery still has to precede the step that uses an action, which is what stops the agent inventing one.

The tool is turn-scoped. The MCP endpoint does not expose it, because an MCP call is its own request against the persisted draft, which makes the state it began in the state it is already in.
