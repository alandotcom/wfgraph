/**
 * A server implementing OpenAI's Chat Completions API as the build agent's
 * model. Pass what `wfOpenAiCompatible` returns as the `agent` option.
 */

export {
  wfOpenAiCompatible,
  type OpenAiCompatibleAgentOptions,
} from "#src/backend/agent/providers/openai-compatible";
