/**
 * The record of one agent turn the browser sends back with the conversation,
 * and the conversation itself as the server takes it.
 *
 * The browser is the one place a turn's history lives, so it is also the one
 * place that can tell the model what an earlier turn did. What it keeps is
 * small on purpose: each tool call's name and outcome, and the ids and labels
 * of the nodes the turn added, changed and removed. Whole graphs and tool
 * payloads stay out, because the server already sends the current graph and
 * the model can read any node again.
 */

import type {
  ThreadAssistantMessagePart,
  ThreadMessage,
} from "@assistant-ui/react";
import { isEqual } from "es-toolkit/predicate";
import { sumBy } from "es-toolkit/math";
import {
  type AgentMessage,
  type AgentTurnRecord,
  MAX_AGENT_TURN_RECORD_ENTRIES,
} from "@wfgraph/shared/rpc/agent-stream";
import {
  MAX_AGENT_MESSAGE_CHARS,
  MAX_AGENT_MESSAGES,
  MAX_AGENT_REQUEST_CHARS,
} from "@wfgraph/shared/rpc/contracts/agent";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { isBlank } from "@wfgraph/shared/types/string";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { readTurnMetadata } from "#src/components/agent/turn-metadata";

/** How much of a tool's sentence the record keeps. */
const MAX_RECORDED_SUMMARY_CHARS = 300;

type TurnNodes = NonNullable<AgentTurnRecord["nodes"]>;

function clipped(text: string): string {
  return text.length <= MAX_RECORDED_SUMMARY_CHARS
    ? text
    : `${text.slice(0, MAX_RECORDED_SUMMARY_CHARS - 1)}…`;
}

/** Every settled tool call in the turn, with its outcome. */
export function recordedTools(
  content: readonly ThreadAssistantMessagePart[]
): NonNullable<AgentTurnRecord["tools"]> {
  return content
    .flatMap((part) =>
      part.type === "tool-call" && part.result !== undefined
        ? [
            omitUndefined({
              name: part.toolName,
              failed: part.isError === true,
              summary:
                typeof part.result === "string"
                  ? clipped(part.result)
                  : undefined,
            }),
          ]
        : []
    )
    .slice(-MAX_AGENT_TURN_RECORD_ENTRIES);
}

function capped(nodes: readonly WorkflowNode[]) {
  return nodes
    .slice(0, MAX_AGENT_TURN_RECORD_ENTRIES)
    .map((node) => ({ id: node.id, label: node.data.label }));
}

/**
 * The nodes a turn added, changed and removed, from the graph it started on
 * and the last one it drew. A node changed when its data did; a move alone
 * is the layout's, not an edit worth telling anyone about.
 */
export function nodeChanges(
  before: readonly WorkflowNode[],
  after: readonly WorkflowNode[]
): TurnNodes {
  const earlier = new Map(before.map((node) => [node.id, node]));
  const later = new Map(after.map((node) => [node.id, node]));

  return {
    added: capped(after.filter((node) => !earlier.has(node.id))),
    changed: capped(
      after.filter((node) => {
        const previous = earlier.get(node.id);
        return previous !== undefined && !isEqual(previous.data, node.data);
      })
    ),
    removed: capped(before.filter((node) => !later.has(node.id))),
  };
}

/** True when the turn added, changed or removed at least one node. */
export function changedAnyNode(nodes: TurnNodes | undefined): boolean {
  return (
    nodes !== undefined &&
    nodes.added.length + nodes.changed.length + nodes.removed.length > 0
  );
}

/**
 * The record one finished assistant message sends: what it stored while it
 * streamed, and how it ended, which its status says.
 */
function recordOf(message: ThreadMessage): AgentTurnRecord | undefined {
  const { record } = readTurnMetadata(message.metadata.custom);
  const status = message.status;
  const ending =
    status?.type === "incomplete"
      ? status.reason === "cancelled"
        ? { stopped: true as const }
        : typeof status.error === "string"
          ? { error: clipped(status.error) }
          : {}
      : {};
  const combined = { ...record, ...ending };
  return Object.keys(combined).length === 0 ? undefined : combined;
}

/**
 * The conversation as the server takes it: the text of each message, and for
 * an assistant message the record of its turn.
 *
 * An assistant message is sent even when it wrote no text, if it has a record,
 * so a stopped turn reaches the model as a turn that was stopped rather than
 * as two user messages in a row.
 */
export function toAgentMessages(
  messages: readonly ThreadMessage[]
): AgentMessage[] {
  return messages.flatMap((message): AgentMessage[] => {
    if (message.role !== "user" && message.role !== "assistant") {
      return [];
    }

    const content = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    const record = message.role === "assistant" ? recordOf(message) : undefined;

    if (isBlank(content) && record === undefined) {
      return [];
    }
    return [omitUndefined({ role: message.role, content, record })];
  });
}

/**
 * The conversation trimmed to what one request may carry, and how many of the
 * oldest messages that left out.
 *
 * The server refuses more than `MAX_AGENT_MESSAGES` messages, an assistant
 * message longer than `MAX_AGENT_MESSAGE_CHARS`, and a request larger than
 * `MAX_AGENT_REQUEST_CHARS`, so a long thread would otherwise stop working at
 * its hundredth message. An assistant message is clipped to the per-message
 * limit; then the oldest messages are dropped until the rest fit beside the
 * `reservedChars` the graph and the rest of the request take, and the first
 * one kept is a user message, which is how every provider wants a
 * conversation to open. The newest message is always kept.
 */
export function fitAgentMessages(
  messages: readonly AgentMessage[],
  reservedChars: number
): { messages: AgentMessage[]; omitted: number } {
  const clippedMessages = messages.map((message) =>
    message.role === "assistant" &&
    message.content.length > MAX_AGENT_MESSAGE_CHARS
      ? {
          ...message,
          content: `${message.content.slice(0, MAX_AGENT_MESSAGE_CHARS - 1)}…`,
        }
      : message
  );
  const budget = MAX_AGENT_REQUEST_CHARS - reservedChars;
  // `JSON.stringify` of the array is the sum of each message's length plus a
  // comma between them and the two brackets.
  const sizes = clippedMessages.map(
    (message) => JSON.stringify(message).length + 1
  );

  let start = Math.max(0, clippedMessages.length - MAX_AGENT_MESSAGES);
  let total = sumBy(sizes.slice(start), (size) => size) + 1;
  while (
    start < clippedMessages.length - 1 &&
    (total > budget || clippedMessages[start]?.role !== "user")
  ) {
    total -= sizes[start] ?? 0;
    start += 1;
  }

  return { messages: clippedMessages.slice(start), omitted: start };
}
