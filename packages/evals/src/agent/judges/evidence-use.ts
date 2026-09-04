import { WRITE_TOOL_NAMES } from "@wfgraph/agent/toolkit";
import type { DeterministicAssessment } from "#src/agent/assessment";
import type {
  AgentTrajectory,
  AgentTrajectoryToolCall,
} from "#src/agent/trajectory";

function actionId(call: AgentTrajectoryToolCall): string | undefined {
  const value = call.input.actionId;
  return typeof value === "string" ? value : undefined;
}

function succeededBefore(
  calls: readonly AgentTrajectoryToolCall[],
  call: AgentTrajectoryToolCall,
  predicate: (candidate: AgentTrajectoryToolCall) => boolean
): boolean {
  return calls.some(
    (candidate) =>
      candidate.order < call.order &&
      candidate.result !== undefined &&
      !candidate.result.failed &&
      candidate.result.order < call.order &&
      predicate(candidate)
  );
}

/** Requires confirmed workflow and action evidence before graph mutations. */
export function assessEvidenceUse(
  trajectory: AgentTrajectory
): DeterministicAssessment {
  for (const call of trajectory.calls) {
    if (!WRITE_TOOL_NAMES.has(call.name)) {
      continue;
    }

    if (
      !succeededBefore(
        trajectory.calls,
        call,
        (candidate) => candidate.name === "read_workflow"
      )
    ) {
      return {
        score: 0,
        rationale: `${call.name} was called before a successful read_workflow result.`,
      };
    }

    if (call.name !== "add_node") {
      continue;
    }

    const addedActionId = actionId(call);
    if (addedActionId === undefined) {
      return {
        score: 0,
        rationale: "add_node was called without an actionId.",
      };
    }
    if (
      !succeededBefore(
        trajectory.calls,
        call,
        (candidate) =>
          candidate.name === "describe_action" &&
          actionId(candidate) === addedActionId
      )
    ) {
      return {
        score: 0,
        rationale: `${addedActionId} was added before a successful describe_action result.`,
      };
    }
  }

  return {
    score: 1,
    rationale: "Successful discovery evidence preceded every graph mutation.",
  };
}
