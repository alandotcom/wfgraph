import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { makeBuiltInAgentRunner } from "@wfgraph/core/backend/agent/chat";
import {
  createWorkflowAgentHarness,
  readEvalModelSettings,
} from "#src/agent/harness";
import {
  CompletionOutcomeJudge,
  EditSafetyJudge,
  EfficiencyBudgetJudge,
  EvidenceUseJudge,
  GroundedGraphJudge,
  RecoveryJudge,
  ResolvableReferencesJudge,
  ScenarioSemanticsJudge,
  ValidationJudge,
} from "#src/agent/judges/index";
import {
  capabilityScenarios,
  complexScenarios,
  focusedScenarios,
} from "#src/agent/scenarios";

const workflowAgentHarness = createWorkflowAgentHarness((input) =>
  makeBuiltInAgentRunner(readEvalModelSettings(input.model))
);

const deterministicJudges = [
  CompletionOutcomeJudge,
  GroundedGraphJudge,
  ScenarioSemanticsJudge,
  ResolvableReferencesJudge,
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
    judgeThreshold: 1,
    skipIf: skipWithoutModelKey,
  },
  (it) => {
    it.for(complexTrials)(
      "$name (trial $trial)",
      async ({ input }, { run }) => {
        const result = await run(input);

        if (input.expected.efficiencyBudget !== undefined) {
          await expect(result).toSatisfyJudge(EfficiencyBudgetJudge, {
            threshold: null,
          });
        }
      }
    );
  }
);

// Five trials because one is a coin toss: single-run agent scores move by
// several points between identical runs, and four is the smallest count whose
// best possible outcome can separate two configurations at all. These scenarios
// are expected to fail while the behaviour they measure is still being built,
// which is what makes them capability rather than regression scenarios.
const capabilityTrials = capabilityScenarios.flatMap((entry) =>
  [1, 2, 3, 4, 5].map((trial) => ({ ...entry, trial }))
);

describeEval(
  "workflow build agent capability behavior",
  {
    harness: workflowAgentHarness,
    judges: deterministicJudges,
    judgeThreshold: 1,
    skipIf: skipWithoutModelKey,
  },
  (it) => {
    it.for(capabilityTrials)(
      "$name (trial $trial)",
      async ({ input }, { run }) => {
        const result = await run(input);
        if (input.expected.efficiencyBudget !== undefined) {
          await expect(result).toSatisfyJudge(EfficiencyBudgetJudge, {
            threshold: null,
          });
        }
      }
    );
  }
);
