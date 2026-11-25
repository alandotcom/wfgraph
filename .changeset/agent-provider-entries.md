---
"@wfgraph/core": minor
---

Each model provider for the build agent has its own entry, and the `agent` option takes what that entry's function returns. Import `wfOpenAi` from `@wfgraph/core/openai`, `wfAnthropic` from `@wfgraph/core/anthropic`, `wfOpenRouter` from `@wfgraph/core/openrouter` or `wfOpenAiCompatible` from `@wfgraph/core/openai-compatible`, and pass the result as `agent` to `createWfGraphApp` or from a `wfWorker` request. Each function takes the options the provider took before, `maxConcurrentTurns` included, with the same defaults: a blank `apiKey`, or a blank `baseUrl` for `wfOpenAiCompatible`, leaves the agent off, and a blank `model` for a provider with no default throws where the host calls the function.

The plain-object form is removed, with or without a `provider` key, along with the `WfGraphOpenAiAgentConfig`, `WfGraphAnthropicAgentConfig`, `WfGraphOpenRouterAgentConfig`, `WfGraphOpenAiCompatibleAgentConfig`, `WfGraphModelAgentConfig`, `WfGraphAgentCapacityConfig`, `AgentReasoningEffort` and `AnthropicReasoningEffort` exports of `@wfgraph/core`. Each entry exports its function's options type, such as `AnthropicAgentOptions`, and `@wfgraph/core` exports `WfGraphAgentModel`, the type a provider function returns. `{ runner, maxConcurrentTurns }` is unchanged.

Before:

```ts
createWfGraphApp({
  agent: {
    provider: "anthropic",
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: "claude-sonnet-5-5",
  },
});
```

After:

```ts
import { wfAnthropic } from "@wfgraph/core/anthropic";

createWfGraphApp({
  agent: wfAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: "claude-sonnet-5-5",
  }),
});
```

A host now loads only the provider it uses.
