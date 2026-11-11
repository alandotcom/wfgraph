---
"@wfgraph/core": minor
---

The build agent's default model is now `gpt-6.1-terra`. A host that set no `agent.model` moves to it on upgrade; set `agent.model: "gpt-6-luna"` for the lowest cost per turn. `agent.reasoningEffort` no longer accepts `minimal`, which no GPT-6 model takes.
