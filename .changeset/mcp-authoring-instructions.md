---
"@wfgraph/core": minor
---

The MCP endpoint now sends the build agent's authoring rules as the server's `instructions` and registers a `build_workflow` prompt carrying the same rules, so an MCP client builds to the rules the editor's chat agent follows: create the Lifecycle Node first, take reference tokens only from `list_references`, and validate at the end.
