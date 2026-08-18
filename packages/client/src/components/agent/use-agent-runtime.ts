/**
 * The chat runtime the agent panel renders, wired to the one streaming RPC.
 *
 * assistant-ui keeps the thread in the browser and asks this adapter to produce
 * one turn, so the whole conversation and the whole graph travel with each call
 * and the server holds nothing between turns.
 *
 * The adapter yields cumulative content, which is what `useLocalRuntime` expects:
 * each tick replaces the assistant message rather than appending to it.
 */

import {
  type ChatModelAdapter,
  type ThreadAssistantMessagePart,
  type ThreadMessage,
  useLocalRuntime,
} from "@assistant-ui/react";
import { useSetAtom } from "jotai";
import { useMemo } from "react";
import type { AgentMessage } from "@wfgraph/shared/rpc/agent-stream";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { appStore } from "#src/lib/app-store";
import { rpc, toSerializedGraph } from "#src/lib/rpc-client";
import {
  applyAgentGraphAtom,
  edgesAtom,
  nodesAtom,
} from "#src/lib/workflow-graph-store";
import { toEditorEdge, toEditorNode } from "#src/lib/workflow-graph-types";
import { isGeneratingAtom } from "#src/lib/workflow-ui-store";

/**
 * The conversation as the server takes it.
 *
 * Only text crosses: a tool call is the server's own record of what it did, and
 * replaying it as a message would tell the model its edits twice.
 */
function toAgentMessages(messages: readonly ThreadMessage[]): AgentMessage[] {
  const sent: AgentMessage[] = [];

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    const content = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");

    if (content.trim().length > 0) {
      sent.push({ role: message.role, content });
    }
  }

  return sent;
}

/** Text, reasoning and tool calls, in the order the turn produced them. */
type TurnContent = ThreadAssistantMessagePart[];

/**
 * Append a delta to the run of text or reasoning already in progress, or start a
 * new one.
 *
 * Message parts are readonly, so the trailing part is replaced rather than
 * appended to. That also gives assistant-ui a new object per tick, which is what
 * makes it repaint.
 */
function withDelta(
  content: TurnContent,
  kind: "text" | "reasoning",
  delta: string
): TurnContent {
  const last = content.at(-1);
  if (last?.type === kind) {
    return [
      ...content.slice(0, -1),
      { ...last, type: kind, text: last.text + delta },
    ];
  }
  return [...content, { type: kind, text: delta }];
}

/** Fold a tool's answer onto the call that asked for it. */
function withToolResult(
  content: TurnContent,
  input: { toolCallId: string; summary: string; failed: boolean }
): TurnContent {
  return content.map((part) =>
    part.type === "tool-call" && part.toolCallId === input.toolCallId
      ? { ...part, result: input.summary, isError: input.failed }
      : part
  );
}

export function useAgentRuntime(workflowId: string) {
  const catalog = useExtensionCatalog();
  const applyGraph = useSetAtom(applyAgentGraphAtom);
  const setIsGenerating = useSetAtom(isGeneratingAtom);

  const adapter = useMemo<ChatModelAdapter>(
    () => ({
      async *run({ messages, abortSignal }) {
        // The canvas is read straight off the store rather than through a hook,
        // because this runs outside React's render, the same way the save queue
        // reads it.
        const graph = toSerializedGraph({
          nodes: appStore.get(nodesAtom),
          edges: appStore.get(edgesAtom),
        });

        setIsGenerating(true);
        let content: TurnContent = [];

        try {
          const stream = await rpc.agent.chat(
            { workflowId, messages: toAgentMessages(messages), graph },
            { signal: abortSignal }
          );

          for await (const part of stream) {
            switch (part.type) {
              case "text-delta": {
                content = withDelta(content, "text", part.delta);
                break;
              }

              case "reasoning-delta": {
                content = withDelta(content, "reasoning", part.delta);
                break;
              }

              case "tool-call": {
                content = [
                  ...content,
                  {
                    type: "tool-call",
                    toolCallId: part.id,
                    toolName: part.name,
                    args: part.input,
                    argsText: JSON.stringify(part.input),
                  },
                ];
                break;
              }

              case "tool-result": {
                content = withToolResult(content, {
                  toolCallId: part.id,
                  summary: part.summary,
                  failed: part.failed,
                });
                break;
              }

              case "graph": {
                // The canvas redraws mid-turn, which is the point: the user
                // watches the workflow being built rather than waiting for it.
                const { nodes, edges } = toWorkflowGraphData(part.graph);
                applyGraph({
                  nodes: nodes.map(toEditorNode),
                  edges: edges.map(toEditorEdge),
                  catalog,
                });
                break;
              }

              case "error": {
                // Not prose. A failure rendered as an ordinary reply reads as
                // the agent saying something, so it goes on a part of its own
                // that the thread draws as a failure.
                content = [
                  ...content,
                  {
                    type: "tool-call",
                    toolCallId: `error-${content.length}`,
                    toolName: "Something went wrong",
                    args: {},
                    argsText: "{}",
                    result: part.message,
                    isError: true,
                  },
                ];
                break;
              }
            }

            yield { content };
          }
        } finally {
          setIsGenerating(false);
        }
      },
    }),
    [applyGraph, catalog, setIsGenerating, workflowId]
  );

  return useLocalRuntime(adapter);
}
