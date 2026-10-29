---
"@wfgraph/client": patch
---

The agent panel now shows how long each tool call took, and its reasoning panel settles to "Thought for Ns" rather than "Done thinking". The chat adapter stamps assistant-ui's part timing on each reasoning passage and tool call, which `useLocalRuntime` does not measure for an adapter.
