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
  groupScenarios,
} from "#src/agent/scenarios";
import { describeEval } from "#src/eval/describe-eval";

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

// The efficiency judge is advisory: a scenario's budget is a measurement to
// watch, and going over it does not fail the case.
const suiteOptions = {
  harness: workflowAgentHarness,
  judges: deterministicJudges,
  advisoryJudges: [EfficiencyBudgetJudge],
  skip: !process.env.OPENAI_API_KEY?.trim(),
};

describeEval("workflow build agent focused behavior", suiteOptions, (it) => {
  it.for(focusedScenarios)("$name", async ({ input }, { run }) => {
    await run(input);
  });
});

describeEval("workflow build agent Group behavior", suiteOptions, (it) => {
  it.for(groupScenarios)("$name", async ({ input }, { run }) => {
    await run(input);
  });
});

const complexTrials = complexScenarios.flatMap((entry) =>
  [1, 2, 3].map((trial) => ({ ...entry, trial }))
);

describeEval("workflow build agent complex behavior", suiteOptions, (it) => {
  it.for(complexTrials)("$name (trial $trial)", async ({ input }, { run }) => {
    await run(input);
  });
});

// Five trials because one is a coin toss: single-run agent scores move by
// several points between identical runs, and four is the smallest count whose
// best possible outcome can separate two configurations at all. These scenarios
// are expected to fail while the behaviour they measure is still being built,
// which is what makes them capability rather than regression scenarios.
const capabilityTrials = capabilityScenarios.flatMap((entry) =>
  [1, 2, 3, 4, 5].map((trial) => ({ ...entry, trial }))
);

describeEval("workflow build agent capability behavior", suiteOptions, (it) => {
  it.for(capabilityTrials)(
    "$name (trial $trial)",
    async ({ input }, { run }) => {
      await run(input);
    }
  );
});
