/** Normalizes the production agent stream for eval assertions and reports. */
import type { TranscriptEvent } from "vitest-evals";
import type { AgentDocument } from "@wfgraph/agent/document";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import type { AgentStreamPart } from "@wfgraph/shared/rpc/agent-stream";

export type AgentEvalDocument = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

export type AgentEvalResult = {
  finalDocument: AgentEvalDocument;
  finalText: string;
  errors: string[];
  events: TranscriptEvent[];
};

function mutableDocument(document: AgentDocument): AgentEvalDocument {
  return { nodes: [...document.nodes], edges: [...document.edges] };
}

/** Converts the client stream into the stable values and transcript an eval reads. */
export function collectAgentEvalResult(
  initialDocument: AgentDocument,
  parts: readonly AgentStreamPart[]
): AgentEvalResult {
  let finalDocument = mutableDocument(initialDocument);
  let pendingText = "";
  let finalText = "";
  const errors: string[] = [];
  const events: TranscriptEvent[] = [];

  const flushText = () => {
    if (pendingText.length === 0) {
      return;
    }
    events.push({ type: "message", role: "assistant", content: pendingText });
    pendingText = "";
  };

  for (const part of parts) {
    switch (part.type) {
      case "text-delta":
        pendingText += part.delta;
        finalText += part.delta;
        break;
      case "tool-call":
        flushText();
        events.push({
          type: "tool_call",
          id: part.id,
          name: part.name,
          arguments: { ...part.input },
        });
        break;
      case "tool-result":
        flushText();
        events.push(
          part.failed
            ? {
                type: "tool_result",
                toolCallId: part.id,
                name: part.name,
                error: { message: part.summary, type: "tool_refusal" },
              }
            : {
                type: "tool_result",
                toolCallId: part.id,
                name: part.name,
                content: { summary: part.summary },
              }
        );
        break;
      case "graph":
        finalDocument = toWorkflowGraphData(part.graph);
        break;
      case "error":
        errors.push(part.message);
        break;
      case "reasoning-delta":
        break;
    }
  }
  flushText();

  return { finalDocument, finalText, errors, events };
}
