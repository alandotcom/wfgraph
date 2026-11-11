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
import {
  type AgentMessage,
  type AgentTurnRecord,
  MAX_AGENT_TURN_RECORD_ENTRIES,
} from "@wfgraph/shared/rpc/agent-stream";
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
