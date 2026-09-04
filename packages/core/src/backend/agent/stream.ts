/**
 * Effect's response stream, read as the six parts the chat panel renders.
 *
 * A pure function per part, so the whole mapping is testable against a fixture
 * list with no model and no request. What it drops is as deliberate as what it
 * keeps: the start, end and parameter-delta parts describe a structure the panel
 * rebuilds from accumulated content, so forwarding them would only add traffic.
 *
 * A `graph` part is not produced here. It is the caller's, because only the
 * caller holds the draft the write tool just changed.
 */

import type { Response, Toolkit } from "effect/unstable/ai";
import type { agentToolkit } from "@wfgraph/agent/toolkit";
import type { AgentStreamPart } from "@wfgraph/shared/rpc/agent-stream";
import { readJsonObject } from "@wfgraph/shared/types/json";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { getErrorMessage } from "@wfgraph/shared/utils";

/**
 * The sentence the panel shows once a tool call settles.
 *
 * Every write tool answers a `summary` and every refusal answers a `reason`, so
 * those two are read by name. Anything else is a read tool, whose result is data
 * the model wanted rather than something a person needs spelled out; it answers
 * nothing here, and the panel keeps the phrase it drew from the call itself.
 */
export function summarizeToolResult(input: {
  readonly name: string;
  readonly result: unknown;
  readonly isFailure: boolean;
}): string | undefined {
  const fields = readJsonObject(input.result);

  if (input.isFailure) {
    const reason = fields?.reason;
    return typeof reason === "string" ? reason : `${input.name} failed.`;
  }

  const summary = fields?.summary;
  return typeof summary === "string" ? summary : undefined;
}

/**
 * One response part as one wire part, or nothing when the panel has no use
 * for it.
 */
type AgentStreamPartIn = Response.StreamPart<
  Toolkit.Tools<typeof agentToolkit>
>;

export function toAgentStreamPart(
  part: AgentStreamPartIn
): AgentStreamPart | undefined {
  switch (part.type) {
    case "text-delta":
      return { type: "text-delta", id: part.id, delta: part.delta };

    case "reasoning-delta":
      return { type: "reasoning-delta", id: part.id, delta: part.delta };

    case "tool-call":
      return {
        type: "tool-call",
        id: part.id,
        name: part.name,
        // The model fills these in, so they arrived as JSON however the tool
        // declared them.
        input: readJsonObject(part.params) ?? {},
      };

    case "tool-result": {
      const summary = summarizeToolResult({
        name: part.name,
        result: part.result,
        isFailure: part.isFailure,
      });

      return omitUndefined({
        type: "tool-result" as const,
        id: part.id,
        name: part.name,
        summary,
        failed: part.isFailure,
      });
    }

    case "error":
      return { type: "error", message: getErrorMessage(part.error) };

    default:
      return undefined;
  }
}
