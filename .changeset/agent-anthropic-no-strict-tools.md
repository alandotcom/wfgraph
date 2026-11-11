---
"@wfgraph/core": patch
---

The build agent runs on `agent.provider: "anthropic"`. Every turn was refused with "Too many strict tools", because the agent's toolkit holds more than the 20 strict tools Anthropic accepts in one request. The tools are now sent without `strict`, and each tool still validates its own arguments.
