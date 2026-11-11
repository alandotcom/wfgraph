/**
 * What the panel keeps about one finished agent turn, beside its parts.
 *
 * assistant-ui carries a message's `metadata.custom` through the thread and
 * into the browser's stored copy of it untyped, so it is written here and read
 * back through a schema: a stored thread from an older build, or one a person
 * edited, decodes to nothing rather than to a wrong figure.
 */

import { Option, Schema } from "effect";
import {
  type AgentUsagePart,
  agentUsagePartSchema,
} from "@wfgraph/shared/rpc/agent-stream";

const turnMetadataSchema = Schema.Struct({
  usage: Schema.optionalKey(agentUsagePartSchema),
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
