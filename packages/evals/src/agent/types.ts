import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { AgentMessage } from "@wfgraph/shared/rpc/agent-stream";
import type { AgentDocument } from "@wfgraph/agent/document";
import type { DeterministicAssessment } from "#src/agent/judges/graph";

export type EvalNodeSelector =
  | { kind: "lifecycle" }
  | { kind: "action"; actionId: string; label?: string };

export type AgentEvalExpectations = {
  requiredActions?: Record<string, number>;
  forbiddenActions?: string[];
  startEvents?: string[];
  cancelEvents?: string[];
  requiredFlows?: Array<{
    source: EvalNodeSelector;
    target: EvalNodeSelector;
    sourceHandle?: string;
  }>;
  preserveNodeIds?: string[];
};

export type AgentEvalInput = {
  messages: AgentMessage[];
  document: AgentDocument;
  catalog: ExtensionCatalog;
  integrations: Array<{ id: string; type: string }>;
  expected: AgentEvalExpectations;
  intentCriteria: string[];
  model?: string;
};

export type AgentEvalOutput = {
  finalDocumentJson: string;
  finalText: string;
  errors: string[];
  publishability: DeterministicAssessment;
  grounding: DeterministicAssessment;
  semantics: DeterministicAssessment;
  toolBehavior: DeterministicAssessment;
};
