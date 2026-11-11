/**
 * What the build agent sends back while a turn runs.
 *
 * Seven cases, shaped for what the chat panel renders rather than for what the
 * model produced. The server maps Effect's richer `Response.StreamPart` onto
 * this, so a change in the AI runtime's own vocabulary stops at that mapping
 * instead of reaching the editor.
 *
 * The `graph` part is the whole channel the canvas needs: it carries the
 * workflow as it stands after a write tool ran, and the editor applies it.
 */

import { Schema } from "effect";
import { serializedWorkflowGraphSchema } from "#src/graph/schemas";
import { jsonObjectSchema } from "#src/types/json";
import { listOf, nonNegativeInteger } from "#src/types/schema";

/** Prose the assistant is writing, one delta at a time. */
const textDeltaPart = Schema.Struct({
  type: Schema.Literal("text-delta"),
  /** Groups the deltas belonging to one block of prose. */
  id: Schema.String,
  delta: Schema.String,
});

/** The model's own reasoning, where the provider exposes it. */
const reasoningDeltaPart = Schema.Struct({
  type: Schema.Literal("reasoning-delta"),
  id: Schema.String,
  delta: Schema.String,
});

/** A tool the model decided to call, with the arguments it settled on. */
const toolCallPart = Schema.Struct({
  type: Schema.Literal("tool-call"),
  id: Schema.String,
  name: Schema.String,
  input: jsonObjectSchema,
});

/** What that call answered. */
const toolResultPart = Schema.Struct({
  type: Schema.Literal("tool-result"),
  id: Schema.String,
  name: Schema.String,
  /**
   * The sentence the panel shows once the call settles, where the tool knows
   * something the call itself did not say. A read tool answers none, and the
   * panel keeps the phrase it drew from the call.
   */
  summary: Schema.optionalKey(Schema.String),
  /** True when the tool refused and the model was told why. */
  failed: Schema.Boolean,
});

/**
 * The workflow after a write tool ran.
 *
 * The graph travels in the same serialized form `workflow.update` takes, so the
 * editor decodes it with the reader it already has.
 */
const graphPart = Schema.Struct({
  type: Schema.Literal("graph"),
  graph: serializedWorkflowGraphSchema,
});

/** The turn ended badly, with a sentence a person can read. */
const errorPart = Schema.Struct({
  type: Schema.Literal("error"),
  message: Schema.String,
});

/**
 * What the turn cost, sent once as its last part when it ends on its own (a
 * stopped turn ends without one). Token counts are summed over the turn's
 * model calls; a provider that reports no count answers 0.
 */
export const agentUsagePartSchema = Schema.Struct({
  type: Schema.Literal("usage"),
  modelCalls: nonNegativeInteger,
  toolCalls: nonNegativeInteger,
  inputTokens: nonNegativeInteger,
  /** The part of `inputTokens` the provider read from its prompt cache. */
  cachedInputTokens: nonNegativeInteger,
  /** Includes `reasoningTokens`. */
  outputTokens: nonNegativeInteger,
  reasoningTokens: nonNegativeInteger,
});

export const agentStreamPartSchema = Schema.Union([
  textDeltaPart,
  reasoningDeltaPart,
  toolCallPart,
  toolResultPart,
  graphPart,
  errorPart,
  agentUsagePartSchema,
]);

export type AgentUsagePart = typeof agentUsagePartSchema.Type;

export type AgentStreamPart = typeof agentStreamPartSchema.Type;

/** A node a turn touched, by id and the label it had. */
const agentTurnNodeSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
});

/** The most tool calls and nodes one turn record names. */
export const MAX_AGENT_TURN_RECORD_ENTRIES = 100;

/**
 * What one past turn did, as the browser saw it stream: each tool call with
 * its outcome, and the nodes the turn added, changed and removed. It is how the
 * model learns, on the next turn, the node ids it created and the refusals it
 * was given, without the browser replaying whole graphs or tool payloads.
 */
export const agentTurnRecordSchema = Schema.Struct({
  tools: Schema.optionalKey(
    listOf(
      Schema.Struct({
        name: Schema.String,
        failed: Schema.Boolean,
        /** The sentence a write answered, or the reason a refusal gave. */
        summary: Schema.optionalKey(Schema.String),
      })
    ).check(Schema.isMaxLength(MAX_AGENT_TURN_RECORD_ENTRIES))
  ),
  nodes: Schema.optionalKey(
    Schema.Struct({
      added: listOf(agentTurnNodeSchema).check(
        Schema.isMaxLength(MAX_AGENT_TURN_RECORD_ENTRIES)
      ),
      changed: listOf(agentTurnNodeSchema).check(
        Schema.isMaxLength(MAX_AGENT_TURN_RECORD_ENTRIES)
      ),
      removed: listOf(agentTurnNodeSchema).check(
        Schema.isMaxLength(MAX_AGENT_TURN_RECORD_ENTRIES)
      ),
    })
  ),
  /** The person stopped the turn before it finished. */
  stopped: Schema.optionalKey(Schema.Literal(true)),
  /** The turn ended on this error. */
  error: Schema.optionalKey(Schema.String),
});

export type AgentTurnRecord = typeof agentTurnRecordSchema.Type;

/**
 * One turn of the conversation, as the browser holds it. An assistant message
 * carries its turn's `record`; a user message carries none.
 */
export const agentMessageSchema = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  content: Schema.String,
  record: Schema.optionalKey(agentTurnRecordSchema),
});

export type AgentMessage = typeof agentMessageSchema.Type;
