---
"@wfgraph/core": minor
"@wfgraph/client": minor
---

A build agent turn now ends with a `usage` part carrying its model calls, tool calls and token counts (input, cached input, output and reasoning), and the Agent panel shows them in one line under each finished turn. A host's `agent.runner` may emit a `usage` part of its own, which is added to the turn's counts.
