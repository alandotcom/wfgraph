---
"@wfgraph/core": minor
---

The build agent now runs on Anthropic, OpenRouter or any OpenAI Chat Completions server as well as OpenAI. `agent.provider` takes `"openai"` (the default, unchanged), `"anthropic"`, `"openrouter"` or `"openai-compatible"`, each through Effect's own provider package. Every provider other than OpenAI requires `agent.model`, and a blank one fails at startup. `"openai-compatible"` is turned on by `agent.baseUrl` and sends `agent.apiKey` only when it is set, for a local server that takes none. A `baseUrl` under the default `"openai"` provider must implement OpenAI's Responses API (`POST /responses`); a gateway serving Chat Completions alone is `"openai-compatible"`. The new config types are exported from `@wfgraph/core`.
