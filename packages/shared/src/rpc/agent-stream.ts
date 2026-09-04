/**
 * What the build agent sends back while a turn runs.
 *
 * Six cases, shaped for what the chat panel renders rather than for what the
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

export const agentStreamPartSchema = Schema.Union([
  textDeltaPart,
  reasoningDeltaPart,
  toolCallPart,
  toolResultPart,
  graphPart,
  errorPart,
]);

export type AgentStreamPart = typeof agentStreamPartSchema.Type;

/** One turn of the conversation, as the browser holds it. */
export const agentMessageSchema = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  content: Schema.String,
});

export type AgentMessage = typeof agentMessageSchema.Type;
