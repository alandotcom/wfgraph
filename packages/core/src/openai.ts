/**
 * OpenAI's Responses API as the build agent's model. Pass what `wfOpenAi`
 * returns as the `agent` option. This is the one entry that loads
 * `@effect/ai-openai`.
 */

export {
  wfOpenAi,
  type OpenAiAgentOptions,
} from "#src/backend/agent/providers/openai";
