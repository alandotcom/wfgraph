import { createJudge } from "vitest-evals";
import type { AgentEvalInput, AgentEvalOutput } from "#src/agent/types";
import { assessExpectedCompletion } from "#src/agent/judges/completion";
import { assessEditSafety } from "#src/agent/judges/edit-safety";
import { assessEfficiencyBudget } from "#src/agent/judges/efficiency";
import { assessEvidenceUse } from "#src/agent/judges/evidence-use";
import { assessGraphGrounding } from "#src/agent/judges/graph";
import { assessRecovery } from "#src/agent/judges/recovery";
import { assessScenarioSemantics } from "#src/agent/judges/semantics";
import { assessValidation } from "#src/agent/judges/validation";

export const CompletionOutcomeJudge = createJudge<
  AgentEvalInput,
  AgentEvalOutput
>("CompletionOutcomeJudge", ({ input, output }) => {
  const assessment = assessExpectedCompletion({
    expected: input.expectedCompletion,
    finalText: output.finalText,
    facts: output.completionFacts,
  });
  return {
    score: assessment.score,
    metadata: {
      expectedOutcome: input.expectedCompletion.outcome,
      graphStatus: output.completionFacts.graphStatus,
      responseStatus: output.completionFacts.responseStatus,
      turnStatus: output.completionFacts.turnStatus,
      rationale: assessment.rationale,
    },
  };
});

export const GroundedGraphJudge = createJudge<AgentEvalInput, AgentEvalOutput>(
  "GroundedGraphJudge",
  ({ input, output }) => {
    const assessment = assessGraphGrounding({
      document: output.finalDocument,
      catalog: input.catalog,
      integrations: input.integrations,
    });
    return {
      score: assessment.score,
      metadata: { rationale: assessment.rationale },
    };
  }
);

export const ScenarioSemanticsJudge = createJudge<
  AgentEvalInput,
  AgentEvalOutput
>("ScenarioSemanticsJudge", ({ input, output }) => {
  const assessment = assessScenarioSemantics(input, output.finalDocument);
  return {
    score: assessment.score,
    metadata: { rationale: assessment.rationale },
  };
});

export const EvidenceUseJudge = createJudge<AgentEvalInput, AgentEvalOutput>(
  "EvidenceUseJudge",
  ({ input, output }) => {
    const assessment = assessEvidenceUse(output.trajectory, input.document);
    return {
      score: assessment.score,
      metadata: { rationale: assessment.rationale },
    };
  }
);

export const EditSafetyJudge = createJudge<AgentEvalInput, AgentEvalOutput>(
  "EditSafetyJudge",
  ({ input, output }) => {
    const assessment = assessEditSafety({
      document: input.document,
      expected: input.expected.editSafety,
      trajectory: output.trajectory,
    });
    return {
      score: assessment.score,
      metadata: { rationale: assessment.rationale },
    };
  }
);

export const RecoveryJudge = createJudge<AgentEvalInput, AgentEvalOutput>(
  "RecoveryJudge",
  ({ output }) => {
    const assessment = assessRecovery({
      facts: output.completionFacts,
      trajectory: output.trajectory,
    });
    return {
      score: assessment.score,
      metadata: { rationale: assessment.rationale },
    };
  }
);

export const ValidationJudge = createJudge<AgentEvalInput, AgentEvalOutput>(
  "ValidationJudge",
  ({ output }) => {
    const assessment = assessValidation({
      facts: output.completionFacts,
      trajectory: output.trajectory,
    });
    return {
      score: assessment.score,
      metadata: { rationale: assessment.rationale },
    };
  }
);

export const EfficiencyBudgetJudge = createJudge<
  AgentEvalInput,
  AgentEvalOutput
>("EfficiencyBudgetJudge", ({ input, output }) => {
  const budget = input.expected.efficiencyBudget;
  if (budget === undefined) {
    return {
      score: 1,
      metadata: {
        rationale: "The scenario has no advisory efficiency budget.",
      },
    };
  }
  const assessment = assessEfficiencyBudget({
    budget,
    traceSummary: output.traceSummary,
  });
  return {
    score: assessment.score,
    metadata: {
      budget,
      traceUsage: {
        modelCalls: output.traceSummary.modelCalls,
        toolCalls: output.traceSummary.toolCalls,
        graphRevisions: output.traceSummary.graphRevisions,
        refusals: output.traceSummary.refusals,
      },
      rationale: assessment.rationale,
    },
  };
});
