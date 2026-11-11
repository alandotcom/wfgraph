---
"@wfgraph/core": patch
---

The "Agent turn finished" log record now carries `usage.cachedInputTokens`, the part of `usage.inputTokens` the provider read from its prompt cache.
