---
"@wfgraph/core": minor
---

New build tool `apply_edits` applies an ordered list of `add_node`, `update_node`, `delete_node`, `connect_nodes`, `disconnect_nodes` and `insert_node_on_edge` operations as one write. Over MCP it stores one revision under one `expectedDraftRevision`; a refused operation stops the batch and nothing is stored. A step an operation creates can carry a `key` that later operations name as `$key`, including inside a reference token. The editor's build agent has the same tool.
