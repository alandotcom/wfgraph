/**
 * What the panel keeps about one finished agent turn, beside its parts.
 *
 * assistant-ui carries a message's `metadata.custom` through the thread and
 * into the browser's stored copy of it untyped, so it is written here and read
 * back through a schema: a stored thread from an older build, or one a person
 * edited, decodes to nothing rather than to a wrong figure.
 */

import { Option, Schema } from "effect";
import { nonNegativeInteger } from "@wfgraph/shared/types/schema";
import {
  type AgentTurnRecord,
  type AgentUsagePart,
  agentTurnRecordSchema,
  agentUsagePartSchema,
} from "@wfgraph/shared/rpc/agent-stream";

const turnMetadataSchema = Schema.Struct({
  usage: Schema.optionalKey(agentUsagePartSchema),
  /**
   * The tools the turn called and the nodes it touched. How the turn ended is
   * the message's status, so the record sent back adds that from there.
   */
  record: Schema.optionalKey(agentTurnRecordSchema),
  /**
   * How many of the oldest messages were left out of this turn's request to
   * keep it inside the server's limits.
   */
  omittedMessages: Schema.optionalKey(nonNegativeInteger),
  /**
   * Names the editor history entry the turn's first edit pushed, which
   * `turn-undo.ts` holds in memory for the panel's "Undo changes".
   */
  undoKey: Schema.optionalKey(Schema.String),
});

export type AgentTurnMetadata = typeof turnMetadataSchema.Type;

const decodeTurnMetadata = Schema.decodeUnknownOption(turnMetadataSchema);

/** The turn's metadata, or an empty record when it holds none we can read. */
export function readTurnMetadata(custom: unknown): AgentTurnMetadata {
  return Option.getOrElse(decodeTurnMetadata(custom), () => ({}));
}

const compactNumber = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The one line under a finished turn: how many model calls and tool calls it
 * made and the tokens it spent, with the cached share named when there is one.
 */
export function usageSummary(usage: AgentUsagePart): string {
  const tokens = usage.inputTokens + usage.outputTokens;
  const cached =
    usage.cachedInputTokens > 0
      ? ` (${compactNumber.format(usage.cachedInputTokens)} cached)`
      : "";
  return [
    plural(usage.modelCalls, "model call"),
    plural(usage.toolCalls, "tool call"),
    `${compactNumber.format(tokens)} tokens${cached}`,
  ].join(" · ");
}

/** The notice a thread shows once its oldest messages leave the request. */
export function omittedMessagesNotice(omitted: number): string {
  return omitted === 1
    ? "The agent no longer sees the oldest message in this conversation."
    : `The agent no longer sees the ${omitted} oldest messages in this conversation.`;
}

/**
 * The one line under a turn that edited the workflow, such as "Added 2 steps,
 * removed 1 step". Each count is capped where the record caps its lists.
 */
export function nodeChangeSummary(
  nodes: NonNullable<AgentTurnRecord["nodes"]>
): string {
  const phrases = [
    ["added", nodes.added.length],
    ["changed", nodes.changed.length],
    ["removed", nodes.removed.length],
  ] as const;
  const sentence = phrases
    .filter(([, count]) => count > 0)
    .map(([verb, count]) => `${verb} ${plural(count, "step")}`)
    .join(", ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
