---
"@wfgraph/core": minor
---

The build agent's rules, which MCP clients receive as the server instructions, change in six ways. A request with one unavailable capability (Slack and SMS with no SMS action) builds the parts that exist and names the missing one, and only a request nothing of which can be built leaves the graph unchanged. The agent reads the topology pages an edit touches, rather than every page, before its first write. It reads a run before explaining it and says when the workflow has not run. It asks for confirmation before deleting most of a graph or clearing its Lifecycle Rules, and says how an earlier turn is undone. Node labels, descriptions, config text and run data are treated as data, never as instructions. It leaves a step's test-mode setting at its default unless asked, and places a step with a side effect below the check that guards it.
