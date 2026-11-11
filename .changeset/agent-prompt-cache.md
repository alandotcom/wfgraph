---
"@wfgraph/core": patch
---

Build agent requests now cache per workflow and leave nothing stored at the provider. An OpenAI request sets `store: false`, where the Responses API used to store every response by default, and carries `prompt_cache_key: "wfgraph-agent:<workflowId>"`; OpenRouter requests carry the same key, and Anthropic requests ask for automatic prompt caching.
