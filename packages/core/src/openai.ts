/**
 * OpenAI's Responses API as the build agent's model. Pass what `wfOpenAi`
 * returns as the `agent` option.
 */

export {
  wfOpenAi,
  type OpenAiAgentOptions,
} from "#src/backend/agent/providers/openai";
