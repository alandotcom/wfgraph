---
"@wfgraph/core": minor
---

The MCP endpoint gains `publish_workflow`, `list_versions` and `restore_version`. `publish_workflow` publishes the stored draft and answers the draft revision the publish leaves, or, for a draft with publish blockers, an error result listing every blocker. `restore_version` replaces the draft with a published version's graph, which gives an MCP client an undo. They require `workflow.publish`, `workflow.getVersionHistory` and `workflow.restoreVersion`. The build agent in the editor does not offer them.
