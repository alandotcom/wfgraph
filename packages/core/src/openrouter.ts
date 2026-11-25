/**
 * OpenRouter as the build agent's model. Pass what `wfOpenRouter` returns as
 * the `agent` option. This is the one entry that loads `@effect/ai-openrouter`.
 */

export {
  wfOpenRouter,
  type OpenRouterAgentOptions,
} from "#src/backend/agent/providers/openrouter";
