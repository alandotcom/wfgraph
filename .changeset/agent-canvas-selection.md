---
"@wfgraph/core": minor
"@wfgraph/client": minor
---

The Agent panel now sends the nodes selected on the canvas with each message, so "change this step" names a step. `agent.chat` takes a required `selectedNodeIds`; the built-in agent names the selected nodes' labels and ids under the newest message, and a host's `agent.runner` receives them as `turn.selectedNodes`.
