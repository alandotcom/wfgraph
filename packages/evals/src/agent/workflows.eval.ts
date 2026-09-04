import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { workflowAgentHarness } from "#src/agent/harness";
import {
  CompletionOutcomeJudge,
  EditSafetyJudge,
  EfficiencyBudgetJudge,
  EvidenceUseJudge,
  GroundedGraphJudge,
  RecoveryJudge,
  ScenarioSemanticsJudge,
  ValidationJudge,
} from "#src/agent/judges/index";
import {
  IntentAlignmentJudge,
  workflowIntentJudgeHarness,
} from "#src/agent/judges/intent";
import { complexScenarios, focusedScenarios } from "#src/agent/scenarios";

const deterministicJudges = [
  CompletionOutcomeJudge,
  GroundedGraphJudge,
  ScenarioSemanticsJudge,
  EvidenceUseJudge,
  EditSafetyJudge,
  RecoveryJudge,
  ValidationJudge,
];

const skipWithoutModelKey = () => !process.env.OPENAI_API_KEY?.trim();

describeEval(
  "workflow build agent focused behavior",
  {
    harness: workflowAgentHarness,
    judges: deterministicJudges,
    judgeThreshold: 1,
    skipIf: skipWithoutModelKey,
  },
  (it) => {
    it.for(focusedScenarios)("$name", async ({ input }, { run }) => {
      const result = await run(input);
      if (input.expected.efficiencyBudget !== undefined) {
        await expect(result).toSatisfyJudge(EfficiencyBudgetJudge, {
          threshold: null,
        });
      }
    });
  }
);

const complexTrials = complexScenarios.flatMap((entry) =>
  [1, 2, 3].map((trial) => ({ ...entry, trial }))
);

describeEval(
  "workflow build agent complex behavior",
  {
    harness: workflowAgentHarness,
    judges: deterministicJudges,
    judgeHarness: workflowIntentJudgeHarness,
    judgeThreshold: 1,
    skipIf: skipWithoutModelKey,
  },
  (it) => {
    it.for(complexTrials)(
      "$name (trial $trial)",
      async ({ input, trial }, { run }) => {
        const result = await run(input);

        if (input.expected.efficiencyBudget !== undefined) {
          await expect(result).toSatisfyJudge(EfficiencyBudgetJudge, {
            threshold: null,
          });
        }

        // One advisory model judgment per scenario limits cost while the three
        // agent trials still measure behavioral variability.
        if (trial === 1) {
          await expect(result).toSatisfyJudge(IntentAlignmentJudge, {
            threshold: null,
          });
        }
      }
    );
  }
);
