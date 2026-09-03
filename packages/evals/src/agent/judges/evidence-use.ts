import { WRITE_TOOL_NAMES } from "@wfgraph/agent/toolkit";
import { findTemplateTokens } from "@wfgraph/shared/graph/node-references";
import { isJsonObject, type JsonValue } from "@wfgraph/shared/types/json";
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

function stringsIn(value: JsonValue): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringsIn);
  }
  if (isJsonObject(value)) {
    return Object.values(value).flatMap(stringsIn);
  }
  return [];
}

function referenceTokensIn(call: AgentTrajectoryToolCall): string[] {
  return stringsIn(call.input).flatMap((value) =>
    findTemplateTokens(value).map((token) => token.raw)
  );
}

function referenceTokensReturnedBy(call: AgentTrajectoryToolCall): string[] {
  const result = call.result?.result;
  if (!isJsonObject(result) || !Array.isArray(result.references)) {
    return [];
  }

  return result.references.flatMap((reference) =>
    isJsonObject(reference) && typeof reference.token === "string"
      ? [reference.token]
      : []
  );
}

function configuredEventNames(call: AgentTrajectoryToolCall): string[] {
  if (call.name === "set_lifecycle_rules") {
    const values = [call.input.startEvents, call.input.cancelEvents];
    return values.flatMap((value) =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : []
    );
  }
  if (call.name !== "set_wait" || !isJsonObject(call.input.wait)) {
    return [];
  }

  const events = call.input.wait.events;
  return Array.isArray(events)
    ? events.flatMap((subscription) =>
        isJsonObject(subscription) && typeof subscription.event === "string"
          ? [subscription.event]
          : []
      )
    : [];
}

/** Requires confirmed workflow and action evidence before graph mutations. */
export function assessEvidenceUse(
  trajectory: AgentTrajectory
): DeterministicAssessment {
  const firstWrite = trajectory.calls.find((call) =>
    WRITE_TOOL_NAMES.has(call.name)
  );

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

    if (call.name === "add_node" || call.name === "insert_node_on_edge") {
      const addedActionId = actionId(call);
      if (addedActionId === undefined) {
        return {
          score: 0,
          rationale: `${call.name} was called without an actionId.`,
        };
      }
      const actionWasDescribed = (boundary: AgentTrajectoryToolCall): boolean =>
        succeededBefore(
          trajectory.calls,
          boundary,
          (candidate) =>
            candidate.name === "describe_action" &&
            actionId(candidate) === addedActionId
        );
      if (!actionWasDescribed(call)) {
        return {
          score: 0,
          rationale: `${addedActionId} was ${call.name === "add_node" ? "added" : "inserted"} before a successful describe_action result.`,
        };
      }
      if (firstWrite && !actionWasDescribed(firstWrite)) {
        return {
          score: 0,
          rationale: `${addedActionId} was ${call.name === "add_node" ? "added" : "inserted"} before capability discovery finished.`,
        };
      }
    }

    for (const eventName of configuredEventNames(call)) {
      const eventWasDescribed = (boundary: AgentTrajectoryToolCall): boolean =>
        succeededBefore(
          trajectory.calls,
          boundary,
          (candidate) =>
            candidate.name === "describe_event" &&
            candidate.input.eventName === eventName
        );
      if (!eventWasDescribed(call)) {
        return {
          score: 0,
          rationale: `${eventName} was used before a successful describe_event result.`,
        };
      }
      if (firstWrite && !eventWasDescribed(firstWrite)) {
        return {
          score: 0,
          rationale: `${eventName} was used before capability discovery finished.`,
        };
      }
    }

    const nodeId = call.input.nodeId;
    for (const token of referenceTokensIn(call)) {
      if (
        typeof nodeId !== "string" ||
        !succeededBefore(
          trajectory.calls,
          call,
          (candidate) =>
            candidate.name === "list_references" &&
            candidate.input.nodeId === nodeId &&
            referenceTokensReturnedBy(candidate).includes(token)
        )
      ) {
        return {
          score: 0,
          rationale: `${token} was used before list_references returned that exact token for ${typeof nodeId === "string" ? nodeId : "the target node"}.`,
        };
      }
    }
  }

  return {
    score: 1,
    rationale: "Successful discovery evidence preceded every graph mutation.",
  };
}
