---
"@wfgraph/plugins": patch
---

The Slack actions' channel placeholder and message descriptions no longer show the `{{NodeName.field}}` form, which contradicted the `{{@nodeId:Label.path}}` token form the editor and the build agent write. The channel placeholder now shows a channel name or ID.
