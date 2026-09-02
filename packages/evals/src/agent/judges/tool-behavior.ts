import type { TranscriptEvent } from "vitest-evals";
import { isBlank } from "@wfgraph/shared/types/string";
import type { DeterministicAssessment } from "#src/agent/judges/graph";

const WRITE_TOOLS = new Set([
  "add_node",
  "update_node",
  "delete_node",
  "connect_nodes",
  "disconnect_nodes",
  "set_lifecycle_rules",
  "set_condition",
  "set_wait",
]);

type EvalToolCall = {
  readonly name: string;
  readonly status: string;
  readonly arguments?: unknown;
};

/** Distinguishes a repaired refusal from a turn that stayed stuck or crashed. */
export function assessConfusion(input: {
  readonly errors: readonly string[];
  readonly finalText: string;
  readonly toolCalls: readonly EvalToolCall[];
}): DeterministicAssessment {
  const failed = input.toolCalls.filter((call) => call.status === "error");
  const unfinished = input.toolCalls.filter(
    (call) => call.status === "pending"
  );
  const repeatedFailure = failed.some((call, index) =>
    failed
      .slice(0, index)
      .some(
        (earlier) =>
          earlier.name === call.name &&
          JSON.stringify(earlier.arguments) === JSON.stringify(call.arguments)
      )
  );
  const endedWithoutAnswer = isBlank(input.finalText);
  if (
    input.errors.length === 0 &&
    unfinished.length === 0 &&
    !repeatedFailure &&
    !endedWithoutAnswer
  ) {
    return failed.length === 0
      ? {
          score: 1,
          rationale: "The turn completed without signs of confusion.",
        }
      : {
          score: 1,
          rationale: `The turn recovered from ${failed.length} refused tool calls and completed.`,
        };
  }

  return {
    score: 0,
    rationale: `The turn had ${failed.length} refused tool calls and ${input.errors.length} stream errors${repeatedFailure ? ", including a repeated refusal" : ""}${unfinished.length > 0 ? `, with ${unfinished.length} unfinished tool call${unfinished.length === 1 ? "" : "s"}` : ""}${endedWithoutAnswer ? ", then ended without an answer" : ""}.`,
  };
}

/** Checks the evidence-gathering and validation sequence in one turn. */
export function assessToolBehavior(
  events: readonly TranscriptEvent[]
): DeterministicAssessment {
  const calls = events.filter((event) => event.type === "tool_call");
  const issues: string[] = [];

  const firstWrite = calls.findIndex((call) => WRITE_TOOLS.has(call.name));
  const firstRead = calls.findIndex((call) => call.name === "read_workflow");
  if (firstWrite >= 0 && (firstRead < 0 || firstRead > firstWrite)) {
    issues.push("the graph was edited before read_workflow");
  }

  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    if (call.name !== "add_node") {
      continue;
    }
    const actionId = call.arguments?.actionId;
    if (typeof actionId !== "string") {
      continue;
    }
    const earlier = calls.slice(0, index);
    const described = earlier.some(
      (candidate) =>
        candidate.name === "describe_action" &&
        candidate.arguments?.actionId === actionId
    );
    if (!described) {
      issues.push(`${actionId} was added before describe_action`);
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
