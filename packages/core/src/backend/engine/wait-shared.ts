/**
 * Shared Wait-node types and store helpers used by the delay and event branches.
 */

import { Effect } from "effect";
import { unwrapStepOutput } from "@wfgraph/shared/graph/node-references";
import type { WaitConfig } from "@wfgraph/shared/lifecycle/wait-subscription";
import {
  type JsonObject,
  type JsonValue,
  readJsonObject,
} from "@wfgraph/shared/types/json";
import type { ExecutionResult } from "#src/backend/engine/contracts";
import type { WorkflowExecutionRuntime } from "#src/backend/engine/runtime";
import type { NodeContext } from "#src/backend/engine/step-log";
import type {
  WorkflowStepLogHandle,
  WorkflowStore,
} from "#src/backend/engine/store";
import type { ResolveTemplates } from "#src/backend/engine/wait-match";
import {
  type EngineFailure,
  failureFromUnknown,
} from "#src/backend/engine/engine-failure";
import type { DatabaseError } from "#src/backend/lib/effect/database";

export type WaitActionInput = {
  config: Record<string, unknown>;
  context: NodeContext;
  runtime: WorkflowExecutionRuntime;
  store: WorkflowStore;
  workflowId: string;
  workflowRunId?: string;
  /** See `WaitBranchContext.resolveTemplates`. */
  resolveTemplates: ResolveTemplates;
};

/**
 * Wait context shared by the delay and event branches.
 */
export type WaitBranchContext = {
  config: WaitConfig;
  context: NodeContext;
  runtime: WorkflowExecutionRuntime;
  store: WorkflowStore;
  workflowId: string;
  runId: string;
  /**
   * Resolves the `{{@nodeId:Label.field}}` references inside a match, which the
   * config-wide template pass does not reach: it walks the config's own string
   * values, and a match sits one level down inside `waitFor`.
   */
  resolveTemplates: ResolveTemplates;
  /** Memoized "step started" log row reused by every branch below. */
  startLog: WorkflowStepLogHandle;
};

/**
 * What the Wait node leaves behind: its own outcome, and whether the run should
 * stop below it.
 *
 * The two are separate because they travel different distances. The outcome is
 * the node's, and it is stored and read back. Halting is the scheduler's, read
 * a few lines from where this is returned and never persisted.
 */
export type WaitOutcome = {
  result: ExecutionResult;
  haltBranch: boolean;
};

export function fromStore<A>(
  effect: Effect.Effect<A, DatabaseError>
): Effect.Effect<A, EngineFailure> {
  return Effect.mapError(effect, failureFromUnknown);
}

export function readWaitGateMode(
  config: WaitConfig
): "require_actual_wait" | "off" {
  return config.waitGateMode === "require_actual_wait"
    ? "require_actual_wait"
    : "off";
}

export function readAllowedHoursConfig(config: WaitConfig) {
  return {
    waitAllowedHoursMode: config.waitAllowedHoursMode,
    waitAllowedStartTime: config.waitAllowedStartTime,
    waitAllowedEndTime: config.waitAllowedEndTime,
  };
}

/**
 * Which Event woke this wait, and what it carried, off the node's stored output.
 *
 * A timeout or a cancel wake leaves the Event out, so null is the honest answer:
 * the Arriving Event did not change.
 */
export function readResumedWaitEvent(output: JsonValue): {
  eventName: string;
  payload: JsonObject;
} | null {
  const record = unwrapStepOutput(output);
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return null;
  }

  const eventName = record.event;
  if (typeof eventName !== "string" || eventName.length === 0) {
    return null;
  }

  return {
    eventName,
    payload: readJsonObject(record.payload) ?? {},
  };
}
