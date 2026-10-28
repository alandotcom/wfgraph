import type { Judge } from "#src/eval/types";
import type { AgentEvalInput, AgentEvalOutput } from "#src/agent/types";
import { assessExpectedCompletion } from "#src/agent/judges/completion";
import { assessEditSafety } from "#src/agent/judges/edit-safety";
import { assessEfficiencyBudget } from "#src/agent/judges/efficiency";
import { assessEvidenceUse } from "#src/agent/judges/evidence-use";
import { assessGraphGrounding } from "#src/agent/judges/graph";
import { assessRecovery } from "#src/agent/judges/recovery";
import { assessResolvableReferences } from "#src/agent/judges/resolvable-references";
import { assessScenarioSemantics } from "#src/agent/judges/semantics";
import { assessValidation } from "#src/agent/judges/validation";

type AgentJudge = Judge<AgentEvalInput, AgentEvalOutput>;

function judge(name: string, assess: AgentJudge["assess"]): AgentJudge {
  return { name, assess };
}

export const CompletionOutcomeJudge = judge(
  "CompletionOutcomeJudge",
  ({ input, output }) => {
    const assessment = assessExpectedCompletion({
      expected: input.expectedCompletion,
      finalText: output.finalText,
      facts: output.completionFacts,
    });
    return {
      score: assessment.score,
      rationale: assessment.rationale,
      metadata: {
        expectedOutcome: input.expectedCompletion.outcome,
        graphStatus: output.completionFacts.graphStatus,
        responseStatus: output.completionFacts.responseStatus,
        turnStatus: output.completionFacts.turnStatus,
      },
    };
  }
);

export const GroundedGraphJudge = judge(
  "GroundedGraphJudge",
  ({ input, output }) => {
    const assessment = assessGraphGrounding({
      document: output.finalDocument,
      catalog: input.catalog,
      integrations: input.integrations,
    });
    return {
      score: assessment.score,
      rationale: assessment.rationale,
    };
  }
);

export const ScenarioSemanticsJudge = judge(
  "ScenarioSemanticsJudge",
  ({ input, output }) => {
    const assessment = assessScenarioSemantics(input, output.finalDocument);
    return {
      score: assessment.score,
      rationale: assessment.rationale,
    };
  }
);

export const ResolvableReferencesJudge = judge(
  "ResolvableReferencesJudge",
  ({ input, output }) => {
    const assessment = assessResolvableReferences({
      document: output.finalDocument,
      catalog: input.catalog,
    });
    return {
      score: assessment.score,
      rationale: assessment.rationale,
    };
  }
);

export const EvidenceUseJudge = judge(
  "EvidenceUseJudge",
  ({ input, output }) => {
    const assessment = assessEvidenceUse(output.trajectory, input.document);
    return {
      score: assessment.score,
      rationale: assessment.rationale,
    };
  }
);

export const EditSafetyJudge = judge("EditSafetyJudge", ({ input, output }) => {
  const assessment = assessEditSafety({
    document: input.document,
    expected: input.expected.editSafety,
    trajectory: output.trajectory,
  });
  return {
    score: assessment.score,
    rationale: assessment.rationale,
  };
});

export const RecoveryJudge = judge("RecoveryJudge", ({ output }) => {
  const assessment = assessRecovery({
    facts: output.completionFacts,
    trajectory: output.trajectory,
  });
  return {
    score: assessment.score,
    rationale: assessment.rationale,
  };
});

export const ValidationJudge = judge("ValidationJudge", ({ output }) => {
  const assessment = assessValidation({
    facts: output.completionFacts,
    trajectory: output.trajectory,
  });
  return {
    score: assessment.score,
    rationale: assessment.rationale,
  };
});

export const EfficiencyBudgetJudge = judge(
  "EfficiencyBudgetJudge",
  ({ input, output }) => {
    const budget = input.expected.efficiencyBudget;
    if (budget === undefined) {
      return {
        score: 1,
        rationale: "The scenario has no advisory efficiency budget.",
      };
    }
    const assessment = assessEfficiencyBudget({
      budget,
      traceSummary: output.traceSummary,
    });
    return {
      score: assessment.score,
      rationale: assessment.rationale,
      metadata: {
        budget,
        traceUsage: {
          modelCalls: output.traceSummary.modelCalls,
          toolCalls: output.traceSummary.toolCalls,
          graphRevisions: output.traceSummary.graphRevisions,
          refusals: output.traceSummary.refusals,
        },
      },
    };
  }
);
