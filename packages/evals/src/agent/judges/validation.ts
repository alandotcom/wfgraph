import { isEqual } from "es-toolkit/predicate";
import { isJsonObject } from "@wfgraph/shared/types/json";
import type { DeterministicAssessment } from "#src/agent/assessment";
import type { CompletionFacts } from "#src/agent/completion-facts";
import type {
  AgentTrajectory,
  AgentTrajectoryToolCall,
} from "#src/agent/trajectory";
import { selectSuccessfulGraphRevisions } from "#src/agent/trajectory";

function successfulValidationAfter(
  trajectory: AgentTrajectory,
  order: number
): AgentTrajectoryToolCall | undefined {
  return trajectory.calls.findLast(
    (call) =>
      call.name === "validate_workflow" &&
      call.order > order &&
      call.result?.failed === false &&
      call.result.order > order
  );
}

function validationMismatch(
  call: AgentTrajectoryToolCall,
  facts: CompletionFacts
): string | undefined {
  const result = call.result?.result;
  if (!isJsonObject(result)) {
    return "validate_workflow returned an invalid result.";
  }
  if (result.draftValid !== (facts.graphStatus !== "invalid")) {
    return "validate_workflow draftValid does not match completion facts.";
  }
  if (
    !Array.isArray(result.structuralIssues) ||
    !isEqual(result.structuralIssues, facts.structuralIssues)
  ) {
    return "validate_workflow structuralIssues do not match completion facts.";
  }
  if (!isEqual(result.publishBlockers, facts.publishBlockers)) {
    return "validate_workflow publishBlockers do not match completion facts.";
  }
  if (!isEqual(result.warnings, facts.warnings)) {
    return "validate_workflow warnings do not match completion facts.";
  }
  return undefined;
}

/** Requires a fresh validation result that agrees with the completed draft facts. */
export function assessValidation(input: {
  readonly facts: CompletionFacts;
  readonly trajectory: AgentTrajectory;
}): DeterministicAssessment {
  const finalRevision = selectSuccessfulGraphRevisions(input.trajectory).at(-1);
  if (finalRevision === undefined) {
    return {
      score: 1,
      rationale: "No successful graph revision requires validation.",
    };
  }

  const validation = successfulValidationAfter(
    input.trajectory,
    finalRevision.order
  );
  if (validation === undefined) {
    return {
      score: 0,
      rationale:
        "No successful validate_workflow result came later than the final graph revision.",
    };
  }

  const mismatch = validationMismatch(validation, input.facts);
  return mismatch === undefined
    ? {
        score: 1,
        rationale:
          "A fresh validate_workflow result matches the completion facts.",
      }
    : { score: 0, rationale: mismatch };
}
