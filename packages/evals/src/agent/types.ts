import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { AgentMessage } from "@wfgraph/shared/rpc/agent-stream";
import type { AgentDocument } from "@wfgraph/agent/document";
import type { DeterministicAssessment } from "#src/agent/judges/graph";

export type EvalNodeSelector =
  | { kind: "lifecycle" }
  | { kind: "action"; actionId: string; label?: string };

export type AgentEvalExpectations = {
  requiredActions?: Record<string, number>;
  exactActions?: Record<string, number>;
  forbiddenActions?: string[];
  allowedActions?: string[];
  startEvents?: string[];
  cancelEvents?: string[];
  requiredFlows?: Array<{
    source: EvalNodeSelector;
    target: EvalNodeSelector;
    sourceHandle?: string;
  }>;
  requiredPaths?: Array<{
    source: EvalNodeSelector;
    target: EvalNodeSelector;
  }>;
  requiredGates?: Array<{
    gate: EvalNodeSelector;
    target: EvalNodeSelector;
    sourceHandle: string;
  }>;
  requiredParallel?: Array<{
    first: EvalNodeSelector;
    second: EvalNodeSelector;
  }>;
  requiredConfigs?: Array<{
    node: EvalNodeSelector;
    values: Record<string, string | number | boolean>;
    allMatches?: boolean;
  }>;
  requiredNonEmptyConfigs?: Array<{
    node: EvalNodeSelector;
    keys: string[];
    allMatches?: boolean;
  }>;
  requiredDurations?: Array<{
    node: EvalNodeSelector;
    key: string;
    duration: string;
  }>;
  requiredWaitEvents?: Array<{
    node: EvalNodeSelector;
    events: string[];
    exact?: boolean;
  }>;
  requiredConditionRules?: Array<{
    node: EvalNodeSelector;
    field: string;
    operator: string;
    value?: string | number;
  }>;
  requiredConditionLogic?: Array<{
    node: EvalNodeSelector;
    groupLogic: "and" | "or";
    ruleLogic?: "and" | "or";
  }>;
  requiredReferences?: Array<{
    node: EvalNodeSelector;
    key: string;
    path: string;
    allMatches?: boolean;
  }>;
  distinctConfigValues?: Array<{
    nodes: EvalNodeSelector;
    key: string;
    count: number;
  }>;
  preserveNodeIds?: string[];
  preserveDocument?: boolean;
};

export type AgentEvalExpectedCompletion =
  | { outcome: "ready" }
  | {
      outcome: "blocked";
      answerMustMention: string[];
      answerMustMentionOneOf?: string[];
      publishBlockerMustMention: string[];
    }
  | {
      outcome: "unsupported";
      answerMustMention?: string[];
      answerMustMentionOneOf?: string[];
    };

export type AgentEvalInput = {
  messages: AgentMessage[];
  document: AgentDocument;
  catalog: ExtensionCatalog;
  integrations: Array<{ id: string; type: string }>;
  expected: AgentEvalExpectations;
  expectedCompletion: AgentEvalExpectedCompletion;
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
  completion: DeterministicAssessment;
};
