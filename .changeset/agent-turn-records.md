---
"@wfgraph/core": minor
"@wfgraph/client": minor
---

The build agent now remembers what its earlier turns did. Each assistant message in `agent.chat`'s `messages` may carry a `record`: its tool calls with their outcomes, the ids and labels of the nodes it added, changed and removed, and whether it was stopped or ended on an error. The Agent panel builds the record as a turn streams, and the built-in agent writes it under that message's text for the model. A turn the person stopped is now sent as an assistant message saying so, where it used to leave two user messages in a row.
