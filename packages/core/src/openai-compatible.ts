/**
 * A server implementing OpenAI's Chat Completions API as the build agent's
 * model. Pass what `wfOpenAiCompatible` returns as the `agent` option. This is
 * the one entry that loads `@effect/ai-openai-compat`.
 */

export {
  wfOpenAiCompatible,
  type OpenAiCompatibleAgentOptions,
} from "#src/backend/agent/providers/openai-compatible";
