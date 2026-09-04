import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { AgentMessage } from "@wfgraph/shared/rpc/agent-stream";
import type { AgentDocument } from "@wfgraph/agent/document";
import type { AgentPublicationBlockerKind } from "@wfgraph/core/backend/agent/publication-validation";
import type { AgentTraceSummary } from "@wfgraph/core/backend/agent/trace";
import type {
  ConditionRule,
  GroupLogic,
} from "@wfgraph/shared/conditions/condition-model";
import type { CompletionFacts } from "#src/agent/completion-facts";
import type { JsonNormalized } from "#src/agent/evidence";
import type { AgentEvalDocument } from "#src/agent/result";
import type { AgentTrajectory } from "#src/agent/trajectory";

type WithoutId<Value> = Value extends { id: string }
  ? Omit<Value, "id">
  : never;

type EvalConditionRule = WithoutId<ConditionRule>;

export type EvalLifecycleFilter = {
  event: string;
  filter: {
    groupLogic: GroupLogic;
    groups: Array<{
      logic: GroupLogic;
      rules: EvalConditionRule[];
    }>;
  };
};

export type AgentEvalEditSafety = {
  protectedNodeIds?: string[];
  protectedEdgeIds?: string[];
  forbiddenMutations?: "all" | string[];
};

export type AgentEvalEfficiencyBudget = {
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxGraphRevisions?: number;
  maxRefusals?: number;
};

export type EvalNodeSelector =
  | { kind: "lifecycle" }
  | { kind: "action"; actionId: string; label?: string };

/** Every kind returned by the canonical agent publication validator. */
export type PublicationBlockerKind = AgentPublicationBlockerKind;

export type AgentEvalExpectations = {
  editSafety?: AgentEvalEditSafety;
  exactActions?: Record<string, number>;
  exactEvents?: {
    start: string[];
    cancel: string[];
  };
  efficiencyBudget?: AgentEvalEfficiencyBudget;
  requiredStartFilters?: EvalLifecycleFilter[];
  requiredCancelFilters?: EvalLifecycleFilter[];
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
  requiredExclusiveBranches?: Array<{
    source: EvalNodeSelector;
    branches: Array<{
      sourceHandle: string;
      target: EvalNodeSelector;
    }>;
  }>;
  requiredConfigs?: Array<{
    node: EvalNodeSelector;
    values: Record<string, string | number | boolean>;
    allMatches?: boolean;
  }>;
  forbiddenConfigKeys?: Array<{
    node: EvalNodeSelector;
    keys: string[];
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
};

export type AgentEvalExpectedCompletion =
  | { outcome: "ready" }
  | { outcome: "clarification"; questionMustMention: string[] }
  | {
      outcome: "blocked";
      answerMustMention: string[];
      answerMustMentionOneOf?: string[];
      requiredPublishBlocker: {
        kind: PublicationBlockerKind;
        messageMustMention: string[];
      };
      allowedPublishBlockerKinds: PublicationBlockerKind[];
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

export type AgentEvalEvidenceDocument = JsonNormalized<AgentEvalDocument>;

export type AgentEvalCompletionFacts = JsonNormalized<CompletionFacts>;
export type AgentEvalTrajectory = JsonNormalized<AgentTrajectory>;
export type AgentEvalTraceSummary = JsonNormalized<AgentTraceSummary, null>;

export type AgentEvalOutput = {
  finalDocument: AgentEvalEvidenceDocument;
  finalText: string;
  errors: string[];
  completionFacts: AgentEvalCompletionFacts;
  trajectory: AgentEvalTrajectory;
  traceSummary: AgentEvalTraceSummary;
};
