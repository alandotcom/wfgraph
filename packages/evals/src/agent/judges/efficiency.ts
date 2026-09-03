import type { DeterministicAssessment } from "#src/agent/assessment";
import type {
  AgentEvalEfficiencyBudget,
  AgentEvalOutput,
} from "#src/agent/types";

type EfficiencyTraceSummary = Pick<
  AgentEvalOutput["traceSummary"],
  "modelCalls" | "toolCalls" | "graphRevisions" | "refusals"
>;

/** Assesses the trace counts against advisory limits declared by a scenario. */
export function assessEfficiencyBudget(input: {
  budget: AgentEvalEfficiencyBudget;
  traceSummary: EfficiencyTraceSummary;
}): DeterministicAssessment {
  const limits = [
    ["model calls", input.traceSummary.modelCalls, input.budget.maxModelCalls],
    ["tool calls", input.traceSummary.toolCalls, input.budget.maxToolCalls],
    [
      "graph revisions",
      input.traceSummary.graphRevisions,
      input.budget.maxGraphRevisions,
    ],
    ["refusals", input.traceSummary.refusals, input.budget.maxRefusals],
  ] as const;
  const exceeded = limits.flatMap(([name, actual, maximum]) =>
    maximum !== undefined && actual > maximum
      ? [`${name} ${actual} exceed the limit of ${maximum}`]
      : []
  );

  return exceeded.length === 0
    ? {
        score: 1,
        rationale:
          "The trace usage stays within the advisory efficiency budget.",
      }
    : { score: 0, rationale: `${exceeded.join("; ")}.` };
}
