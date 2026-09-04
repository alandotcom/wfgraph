import type {
  AgentDraftValidation,
  AgentValidationIssue,
} from "@wfgraph/agent/document";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";

export type GraphStatus = "invalid" | "ready" | "blocked";
export type ResponseStatus = "answered" | "missing";
export type TurnStatus = "completed" | "incomplete" | "failed";

export type CompletionFactIssue = {
  kind: string;
  message: string;
  nodeId?: string;
  nodeLabel?: string;
};

export type CompletionFacts = {
  graphStatus: GraphStatus;
  responseStatus: ResponseStatus;
  turnStatus: TurnStatus;
  structuralIssues: string[];
  publishBlockers: CompletionFactIssue[];
  warnings: CompletionFactIssue[];
  finalFinishReason: string | null;
};

function deriveTurnStatus(input: {
  streamErrors: readonly string[];
  finalFinishReason: string | undefined;
}): TurnStatus {
  if (input.streamErrors.length > 0) {
    return "failed";
  }
  if (input.finalFinishReason === "stop") {
    return "completed";
  }
  return "incomplete";
}

function copyIssue(issue: AgentValidationIssue): CompletionFactIssue {
  return omitUndefined({
    kind: issue.kind,
    message: issue.message,
    nodeId: issue.nodeId,
    nodeLabel: issue.nodeLabel,
  });
}

/** Converts canonical draft validation and turn signals into eval facts. */
export function collectCompletionFacts(input: {
  validation: AgentDraftValidation;
  finalText: string;
  streamErrors: readonly string[];
  finalFinishReason: string | undefined;
}): CompletionFacts {
  return {
    graphStatus: !input.validation.draftValid
      ? "invalid"
      : input.validation.publishBlockers.length === 0
        ? "ready"
        : "blocked",
    responseStatus: input.finalText.trim().length > 0 ? "answered" : "missing",
    turnStatus: deriveTurnStatus(input),
    structuralIssues: [...input.validation.structuralIssues],
    publishBlockers: input.validation.publishBlockers.map(copyIssue),
    warnings: input.validation.warnings.map(copyIssue),
    finalFinishReason: input.finalFinishReason ?? null,
  };
}
