import { workflowTopologyRefusalReason } from "@wfgraph/shared/graph/workflow-topology";
import type { AgentEvalDocument } from "#src/agent/result";
import type { AgentEvalExpectedCompletion } from "#src/agent/types";
import type { DeterministicAssessment } from "#src/agent/judges/graph";

type CompletionAssessmentInput = {
  expected: AgentEvalExpectedCompletion;
  document: AgentEvalDocument;
  finalText: string;
  errors: readonly string[];
  publishability: DeterministicAssessment;
  grounding: DeterministicAssessment;
  semantics: DeterministicAssessment;
};

function failure(rationale: string): DeterministicAssessment {
  return { score: 0, rationale };
}

function answerRequirementFailure(
  expected: Exclude<AgentEvalExpectedCompletion, { outcome: "ready" }>,
  finalText: string
): string | undefined {
  const normalized = finalText.toLocaleLowerCase();
  const missing = (expected.answerMustMention ?? []).filter(
    (term) => !normalized.includes(term.toLocaleLowerCase())
  );
  if (missing.length > 0) {
    return `The answer does not mention: ${missing.join(", ")}.`;
  }
  if (
    expected.answerMustMentionOneOf !== undefined &&
    !expected.answerMustMentionOneOf.some((term) =>
      normalized.includes(term.toLocaleLowerCase())
    )
  ) {
    return `The answer does not mention any of: ${expected.answerMustMentionOneOf.join(", ")}.`;
  }
  return undefined;
}

/** Scores the final state according to the scenario's expected product outcome. */
export function assessExpectedCompletion(
  input: CompletionAssessmentInput
): DeterministicAssessment {
  if (input.errors.length > 0) {
    return failure(
      `The turn ended with ${input.errors.length} stream error${input.errors.length === 1 ? "" : "s"}.`
    );
  }
  if (input.grounding.score === 0) {
    return failure(input.grounding.rationale);
  }
  if (input.semantics.score === 0) {
    return failure(input.semantics.rationale);
  }

  if (input.expected.outcome === "ready") {
    return input.publishability.score === 1
      ? {
          score: 1,
          rationale: "The workflow is ready to publish as expected.",
        }
      : failure(input.publishability.rationale);
  }

  const answerFailure = answerRequirementFailure(
    input.expected,
    input.finalText
  );
  if (answerFailure) {
    return failure(answerFailure);
  }

  if (
    input.expected.outcome === "blocked" &&
    /\b(?:workflow|draft|it) (?:is|'s) ready to publish\b/i.test(
      input.finalText
    )
  ) {
    return failure(
      "The answer claims publish readiness while the workflow has a blocker."
    );
  }

  if (input.expected.outcome === "unsupported") {
    return {
      score: 1,
      rationale:
        "The answer explains the unsupported capability and the graph stays grounded.",
    };
  }

  const topologyError = workflowTopologyRefusalReason(input.document);
  if (topologyError) {
    return failure(topologyError);
  }
  if (input.publishability.score === 1) {
    return failure(
      "The workflow is ready to publish, but a blocked draft was expected."
    );
  }
  const publicationFailure = input.publishability.rationale.toLocaleLowerCase();
  if (
    !input.expected.publishBlockerMustMention.every((term) =>
      publicationFailure.includes(term.toLocaleLowerCase())
    )
  ) {
    return failure(
      "The publication failure does not match the expected human blocker."
    );
  }
  return {
    score: 1,
    rationale:
      "The valid draft contains the requested work and names its publish blocker.",
  };
}
