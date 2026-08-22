import { createJudge } from "vitest-evals";
import type { AgentEvalInput, AgentEvalOutput } from "#src/agent/types";
import {
  assessConfusion,
  assessToolBehavior,
} from "#src/agent/judges/tool-behavior";

export const PublishableGraphJudge = createJudge<
  AgentEvalInput,
  AgentEvalOutput
>("PublishableGraphJudge", ({ output }) => ({
  score: output.publishability.score,
  metadata: { rationale: output.publishability.rationale },
}));

export const GroundedGraphJudge = createJudge<AgentEvalInput, AgentEvalOutput>(
  "GroundedGraphJudge",
  ({ output }) => ({
    score: output.grounding.score,
    metadata: { rationale: output.grounding.rationale },
  })
);

export const ScenarioSemanticsJudge = createJudge<
  AgentEvalInput,
  AgentEvalOutput
>("ScenarioSemanticsJudge", ({ output }) => ({
  score: output.semantics.score,
  metadata: { rationale: output.semantics.rationale },
}));

export const ToolProtocolJudge = createJudge<AgentEvalInput, AgentEvalOutput>(
  "ToolProtocolJudge",
  ({ session }) => {
    const assessment = assessToolBehavior(session.events);
    return {
      score: assessment.score,
      metadata: { rationale: assessment.rationale },
    };
  }
);

export const ConfusionJudge = createJudge<AgentEvalInput, AgentEvalOutput>(
  "ConfusionJudge",
  ({ output, toolCalls }) => {
    const assessment = assessConfusion({
      errors: output.errors,
      finalText: output.finalText,
      toolCalls,
    });
    return {
      score: assessment.score,
      metadata: { rationale: assessment.rationale },
    };
  }
);
