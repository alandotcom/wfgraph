/**
 * Anthropic's Messages API as the build agent's model. Pass what
 * `wfAnthropic` returns as the `agent` option. This is the one entry that
 * loads `@effect/ai-anthropic`.
 */

export {
  wfAnthropic,
  type AnthropicAgentOptions,
} from "#src/backend/agent/providers/anthropic";
