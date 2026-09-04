import type { AgentEvalDocument } from "#src/agent/result";
import type { AgentEvalInput } from "#src/agent/types";
import type { DeterministicAssessment } from "#src/agent/assessment";
import { assessActionAndLifecycleSemantics } from "#src/agent/judges/semantics/actions-lifecycle";
import { assessConfigurationSemantics } from "#src/agent/judges/semantics/configuration-conditions-references";
import { createSemanticsContext } from "#src/agent/judges/semantics/context";
import { assessTopologyAndBranchingSemantics } from "#src/agent/judges/semantics/topology-branching";

/** Checks the graph facts a scenario declares, allowing other valid graph details. */
export function assessScenarioSemantics(
  input: AgentEvalInput,
  document: AgentEvalDocument
): DeterministicAssessment {
  const context = createSemanticsContext(input, document);
  const issues = [
    ...assessActionAndLifecycleSemantics(context),
    ...assessTopologyAndBranchingSemantics(context),
    ...assessConfigurationSemantics(context),
  ];

  return issues.length === 0
    ? {
        score: 1,
        rationale: "The graph satisfies the scenario constraints.",
      }
    : { score: 0, rationale: `${issues.join("; ")}.` };
}
