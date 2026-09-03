import { isEqual } from "es-toolkit/predicate";
import { WRITE_TOOL_NAMES } from "@wfgraph/agent/toolkit";
import type { DeterministicAssessment } from "#src/agent/assessment";
import type { CompletionFacts } from "#src/agent/completion-facts";
import type {
  AgentTrajectory,
  AgentTrajectoryToolCall,
} from "#src/agent/trajectory";
import {
  selectInconsistentGraphRevisionWrites,
  selectUnmatchedGraphRevisions,
  selectUnresolvedCalls,
} from "#src/agent/trajectory";

function hasRepeatedRefusal(
  calls: readonly AgentTrajectoryToolCall[]
): boolean {
  return calls.some(
    (call, index) =>
      call.result?.failed === true &&
      calls
        .slice(0, index)
        .some(
          (earlier) =>
            earlier.result?.failed === true &&
            earlier.name === call.name &&
            isEqual(earlier.input, call.input)
        )
  );
}

function hasLaterStepWriteWithoutFreshRead(
  calls: readonly AgentTrajectoryToolCall[]
): boolean {
  return calls.some((call) => {
    if (!WRITE_TOOL_NAMES.has(call.name)) {
      return false;
    }

    return calls.some((refusal) => {
      const refusalResult = refusal.result;
      return (
        refusalResult?.failed === true &&
        refusalResult.step < call.step &&
        !calls.some(
          (read) =>
            read.name === "read_workflow" &&
            read.result?.failed === false &&
            read.result.order > refusalResult.order &&
            read.result.order < call.order
        )
      );
    });
  });
}

/** Determines whether the turn recovered after failures and reached an answer. */
export function assessRecovery(input: {
  readonly facts: CompletionFacts;
  readonly trajectory: AgentTrajectory;
}): DeterministicAssessment {
  const issues: string[] = [];
  if (input.facts.turnStatus !== "completed") {
    issues.push(`the turn status is ${input.facts.turnStatus}`);
  }
  if (input.trajectory.providerErrors.length > 0) {
    issues.push("the provider emitted an error");
  }
  if (input.facts.responseStatus === "missing") {
    issues.push("the turn has no final answer");
  }
  if (selectUnresolvedCalls(input.trajectory).length > 0) {
    issues.push("the turn has unresolved tool calls");
  }
  if (input.trajectory.unmatchedResults.length > 0) {
    issues.push("the turn has unmatched tool results");
  }
  if (selectUnmatchedGraphRevisions(input.trajectory).length > 0) {
    issues.push("the turn has an unmatched graph revision");
  }
  const inconsistentRevisionWrites = selectInconsistentGraphRevisionWrites(
    input.trajectory
  );
  if (
    inconsistentRevisionWrites.some((write) => write.matchStatus === "missing")
  ) {
    issues.push(
      "the turn has a successful write with a missing graph revision"
    );
  }
  if (
    inconsistentRevisionWrites.some(
      (write) => write.matchStatus === "duplicate"
    )
  ) {
    issues.push(
      "the turn has a successful write with duplicate graph revisions"
    );
  }
  if (
    input.trajectory.graphRevisionSequence.issues.includes(
      "events-out-of-write-order"
    )
  ) {
    issues.push(
      "matched graph revision events do not follow successful write result order"
    );
  }
  if (
    input.trajectory.graphRevisionSequence.issues.includes(
      "revisions-not-sequential"
    )
  ) {
    issues.push(
      "graph revisions must start at 1 and increase by one for each successful write"
    );
  }
  if (hasRepeatedRefusal(input.trajectory.calls)) {
    issues.push("the turn repeated an identical refused tool call");
  }
  if (hasLaterStepWriteWithoutFreshRead(input.trajectory.calls)) {
    issues.push(
      "a write was attempted after a refused tool call without a fresh read_workflow result"
    );
  }

  if (issues.length > 0) {
    return { score: 0, rationale: `Recovery failed: ${issues.join("; ")}.` };
  }

  const refusals = input.trajectory.calls.filter(
    (call) => call.result?.failed === true
  ).length;
  return {
    score: 1,
    rationale:
      refusals === 0
        ? "The turn completed with a final answer and no unresolved tool calls."
        : `The turn recovered from ${refusals} distinct refused tool calls and completed.`,
  };
}
