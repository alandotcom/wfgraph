import type { TranscriptEvent } from "vitest-evals";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import type { DeterministicAssessment } from "#src/agent/judges/graph";

const WRITE_TOOLS = new Set([
  "add_node",
  "update_node",
  "delete_node",
  "connect_nodes",
  "disconnect_nodes",
  "set_lifecycle_rules",
  "set_condition",
]);

const BUILT_INS = new Set<string>(Object.values(BUILT_IN_ACTION_IDS));

/** Checks the evidence-gathering and validation sequence in one turn. */
export function assessToolBehavior(
  events: readonly TranscriptEvent[]
): DeterministicAssessment {
  const calls = events.filter((event) => event.type === "tool_call");
  const issues: string[] = [];

  if (calls[0]?.name !== "read_workflow") {
    issues.push(
      `The first tool was ${calls[0]?.name ?? "none"}, not read_workflow`
    );
  }

  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    if (call.name !== "add_node") {
      continue;
    }
    const actionId = call.arguments?.actionId;
    if (typeof actionId !== "string" || BUILT_INS.has(actionId)) {
      continue;
    }
    const earlier = calls.slice(0, index);
    const listed = earlier.some(
      (candidate) => candidate.name === "list_actions"
    );
    const described = earlier.some(
      (candidate) =>
        candidate.name === "describe_action" &&
        candidate.arguments?.actionId === actionId
    );
    if (!(listed && described)) {
      issues.push(
        `${actionId} was added before list_actions and describe_action`
      );
    }
  }

  const lastSuccessfulWrite = events.findLastIndex(
    (event) =>
      event.type === "tool_result" &&
      WRITE_TOOLS.has(event.name ?? "") &&
      event.error === undefined
  );
  const lastValidation = events.findLastIndex(
    (event) => event.type === "tool_call" && event.name === "validate_workflow"
  );
  if (lastSuccessfulWrite >= 0 && lastValidation < lastSuccessfulWrite) {
    issues.push("the graph changed after the last validate_workflow call");
  }

  return issues.length === 0
    ? {
        score: 1,
        rationale: "The tool trace follows the workflow-authoring protocol.",
      }
    : { score: 0, rationale: `${issues.join("; ")}.` };
}
