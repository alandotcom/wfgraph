---
"@wfgraph/core": minor
---

`agent: { runner }` lets a host run the build agent's turns on its own gateway or model. A `WfGraphAgentRunner` receives a `WfGraphAgentTurn` (the workflow id, the messages, the conversation as an Effect AI prompt under the built-in system prompt, the authoring toolkit bound to the turn's draft, and the abort signal) and answers a stream of the parts the panel renders; Workflow Graph adds the canvas's `graph` parts after each successful write. `streamAgentTurn(turn, model)` runs the built-in loop on a `LanguageModel` layer the host builds. Both, and the types, are exported from `@wfgraph/core`.
