---
"@wfgraph/core": minor
---

Each model provider for the build agent has its own entry, and the `agent` option takes what that entry's function returns. Import `wfOpenAi` from `@wfgraph/core/openai`, `wfAnthropic` from `@wfgraph/core/anthropic`, `wfOpenRouter` from `@wfgraph/core/openrouter` or `wfOpenAiCompatible` from `@wfgraph/core/openai-compatible`, and pass the result as `agent` to `createWfGraphApp` or from a `wfWorker` request. Each function takes the options the provider took before, `maxConcurrentTurns` included, with the same defaults: a blank `apiKey`, or a blank `baseUrl` for `wfOpenAiCompatible`, leaves the agent off. A blank `model` for a provider with no default, or a `maxConcurrentTurns` that is not a positive integer, throws where the host calls the function, with a message naming the function, such as `wfAnthropic needs a non-blank model`.

The plain-object form is removed, with or without a `provider` key, along with the `WfGraphOpenAiAgentConfig`, `WfGraphAnthropicAgentConfig`, `WfGraphOpenRouterAgentConfig`, `WfGraphOpenAiCompatibleAgentConfig`, `WfGraphModelAgentConfig`, `WfGraphAgentCapacityConfig`, `AgentReasoningEffort` and `AnthropicReasoningEffort` exports of `@wfgraph/core`. Each entry exports its function's options type, such as `AnthropicAgentOptions`, and `@wfgraph/core` exports `WfGraphAgentModel`, the opaque type a provider function returns. `{ runner, maxConcurrentTurns }` is unchanged.

From JavaScript, an `agent` value that is neither a provider function's result nor `{ runner }` is refused with a message that names the provider functions and says to leave `agent` out to turn the agent off. `createWfGraphApp` throws it when it is called. `wfWorker` reads `agent` from its `request` callback on each invocation, so it throws the message on each request and tick.

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
