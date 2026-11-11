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
  type ChatModelRunResult,
  type ThreadAssistantMessagePart,
  useLocalRuntime,
} from "@assistant-ui/react";
import { useSetAtom } from "jotai";
import { useMemo } from "react";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import type { AgentTurnRecord } from "@wfgraph/shared/rpc/agent-stream";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import type { AgentTurnMetadata } from "#src/components/agent/turn-metadata";
import {
  changedAnyNode,
  fitAgentMessages,
  nodeChanges,
  recordedTools,
  toAgentMessages,
} from "#src/components/agent/turn-record";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { appStore } from "#src/lib/app-store";
import { rpc, toSerializedGraph } from "#src/lib/rpc-client";
import {
  applyAgentGraphAtom,
  edgesAtom,
  nodesAtom,
} from "#src/lib/workflow-graph-store";
import { toEditorEdge, toEditorNode } from "#src/lib/workflow-graph-types";
import { activeAgentTurnIdAtom } from "#src/lib/workflow-ui-store";
import { activeSelectionAtom } from "#src/lib/workflow-workspace-navigation";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";

/** Text, reasoning and tool calls, in the order the turn produced them. */
type TurnContent = ThreadAssistantMessagePart[];

/**
 * Stamp `completedAt` on a reasoning part still open.
 *
 * A passage of reasoning ends when the turn moves on to anything else, or when
 * the turn ends, and nothing in the stream says so on its own.
 */
function withReasoningSettled(content: TurnContent, now: number): TurnContent {
  return content.map((part) =>
    part.type === "reasoning" &&
    part.timing !== undefined &&
    part.timing.completedAt === undefined
      ? { ...part, timing: { ...part.timing, completedAt: now } }
      : part
  );
}

/**
 * Append a delta to the run of text or reasoning already in progress, or start a
 * new one.
 *
 * Message parts are readonly, so the trailing part is replaced rather than
 * appended to. That also gives assistant-ui a new object per tick, which is what
 * makes it repaint. A reasoning part carries the wall-clock span it streamed
 * for, which `useLocalRuntime` does not measure for an adapter.
 */
function withDelta(
  content: TurnContent,
  kind: "text" | "reasoning",
  delta: string,
  now: number
): TurnContent {
  const last = content.at(-1);
  if (last?.type === kind) {
    return [
      ...content.slice(0, -1),
      { ...last, type: kind, text: last.text + delta },
    ];
  }
  const settled = withReasoningSettled(content, now);
  return kind === "reasoning"
    ? [...settled, { type: kind, text: delta, timing: { startedAt: now } }]
    : [...settled, { type: kind, text: delta }];
}

/**
 * Fold a tool's answer onto the call that asked for it.
 *
 * `result` is how assistant-ui knows a call has finished: a tool-call part
 * without one is still running, and its row keeps a spinner. A read tool sends
 * no summary, because its result is data the model wanted rather than a
 * sentence a person needs, so the answer here is `null`: present, and carrying
 * nothing for the row to print under the name it already has.
 */
function withToolResult(
  content: TurnContent,
  input: {
    toolCallId: string;
    summary: string | undefined;
    failed: boolean;
    now: number;
  }
): TurnContent {
  return content.map((part) =>
    part.type === "tool-call" && part.toolCallId === input.toolCallId
      ? {
          ...part,
          result: input.summary ?? null,
          isError: input.failed,
          timing: {
            startedAt: part.timing?.startedAt ?? input.now,
            completedAt: input.now,
          },
        }
      : part
  );
}

/**
 * One tick of the turn, carrying its failure as the message status and what
 * the panel keeps about the turn as the message's custom metadata.
 */
function turnResult(
  content: TurnContent,
  failure: string | undefined,
  metadata: AgentTurnMetadata
): ChatModelRunResult {
  const custom = { metadata: { custom: metadata } };
  return failure === undefined
    ? { content, ...custom }
    : {
        content,
        ...custom,
        status: {
          type: "incomplete" as const,
          reason: "error" as const,
          error: failure,
        },
      };
}

export function useAgentRuntime(workflowId: string) {
  const catalog = useExtensionCatalog();
  const applyGraph = useSetAtom(applyAgentGraphAtom);

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

        // The graph the turn starts on, against which its record names the
        // nodes it added, changed and removed.
        const startedOn = toWorkflowGraphData(graph).nodes;
        let drawn = startedOn;
        const record = (): AgentTurnRecord => {
          const tools = recordedTools(content);
          const nodes = nodeChanges(startedOn, drawn);
          return omitUndefined({
            tools: tools.length > 0 ? tools : undefined,
            nodes: changedAnyNode(nodes) ? nodes : undefined,
          });
        };

        const selectedNodeIds = [...appStore.get(activeSelectionAtom).nodeIds];
        const sent = fitAgentMessages(
          toAgentMessages(messages),
          JSON.stringify({ workflowId, selectedNodeIds, graph, messages: [] })
            .length
        );

        const turnId = Symbol("agent-turn");
        appStore.set(activeAgentTurnIdAtom, turnId);
        let content: TurnContent = [];
        let hasAppliedGraph = false;
        let failure: string | undefined;
        let metadata: AgentTurnMetadata =
          sent.omitted > 0 ? { omittedMessages: sent.omitted } : {};

        try {
          const stream = await rpc.agent.chat(
            {
              workflowId,
              messages: sent.messages,
              graph,
              // What "this step" means in the message being sent.
              selectedNodeIds,
            },
            { signal: abortSignal }
          );

          for await (const part of stream) {
            const now = Date.now();
            switch (part.type) {
              case "text-delta": {
                content = withDelta(content, "text", part.delta, now);
                break;
              }

              case "reasoning-delta": {
                content = withDelta(content, "reasoning", part.delta, now);
                break;
              }

              case "tool-call": {
                content = [
                  ...withReasoningSettled(content, now),
                  {
                    type: "tool-call",
                    toolCallId: part.id,
                    toolName: part.name,
                    args: part.input,
                    argsText: JSON.stringify(part.input),
                    timing: { startedAt: now },
                  },
                ];
                break;
              }

              case "tool-result": {
                content = withToolResult(content, {
                  toolCallId: part.id,
                  summary: part.summary,
                  failed: part.failed,
                  now,
                });
                break;
              }

              case "graph": {
                // The canvas redraws mid-turn, which is the point: the user
                // watches the workflow being built rather than waiting for it.
                const { nodes, edges } = toWorkflowGraphData(part.graph);
                drawn = nodes;
                const applied = applyGraph({
                  workflowId,
                  turnId,
                  recordHistory: !hasAppliedGraph,
                  nodes: nodes.map(toEditorNode),
                  edges: edges.map(toEditorEdge),
                  catalog,
                });
                hasAppliedGraph ||= applied;
                break;
              }

              case "error": {
                // A failure is the turn's own state, not a part of it. Carried
                // as one, it had to borrow the shape of a tool call, and the
                // thread then had to keep that impostor out of the fold that
                // hides the real ones. assistant-ui reads an incomplete message
                // status and renders it through `ErrorPrimitive`.
                failure = part.message;
                break;
              }

              case "usage": {
                metadata = { ...metadata, usage: part };
                break;
              }
            }

            yield turnResult(content, failure, {
              ...metadata,
              record: record(),
            });
          }

          // Reasoning the turn ended on is closed here, so its panel can say
          // how long it took.
          yield turnResult(withReasoningSettled(content, Date.now()), failure, {
            ...metadata,
            record: record(),
          });
        } finally {
          if (
            appStore.get(currentWorkflowIdAtom) === workflowId &&
            appStore.get(activeAgentTurnIdAtom) === turnId
          ) {
            appStore.set(activeAgentTurnIdAtom, null);
          }
        }
      },
    }),
    [applyGraph, catalog, workflowId]
  );

  return useLocalRuntime(adapter);
}
