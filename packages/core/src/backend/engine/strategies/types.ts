/**
 * What a node strategy needs from the run, and what it reports back.
 *
 * The scheduler owns deferral, drain, branch hand-off, and post-success routing
 * via `routeAfterStrategy`. Strategies own the work of one node kind.
 */

import type { WorkflowActions } from "#src/backend/engine/actions";
import type {
  ExecutionResult,
  NodeOutputs,
} from "#src/backend/engine/contracts";
import type { WorkflowExecutionRuntime } from "#src/backend/engine/runtime";
import type { NodeContext } from "#src/backend/engine/step-log";
import type { WorkflowStore } from "#src/backend/engine/store";
import type { Traversal } from "#src/backend/engine/traversal";
import type { WorkflowNode } from "@rova/shared/graph/types";
import type { JsonObject } from "@rova/shared/types/json";
import type { Effect } from "effect";
import type { EngineFailure } from "#src/backend/engine/engine-failure";

export type NodeWorkOutcome = {
  result: ExecutionResult;
  /** Action node without an actionType: recorded as failed, no output stored. */
  unconfigured?: boolean;
  /**
   * The branch a Condition node picked. Absent on every other node, and absent
   * on a disabled Condition node, which evaluated nothing and halts its branch
   * where it stands.
   */
  conditionValue?: boolean;
  /**
   * Whether the run stops below this node. A Wait that was skipped or woken by
   * a cancel says so, a disabled routing node says so, and a branch that was
   * handed to a durable run of its own says so because that run already walked
   * everything underneath.
   */
  haltBranch?: boolean;
};

export type NodeWorkContext = {
  node: WorkflowNode;
  nodeName: string;
  traversal: Traversal;
  runtime: WorkflowExecutionRuntime;
  store: WorkflowStore;
  actions: WorkflowActions;
  executionId: string;
  workflowId: string;
  workflowRunId: string;
  runMode: "live" | "test";
  startPayload: JsonObject;
  /** Event the nodes running now arrived on. */
  eventName: string | null;
  /** Published catalog fingerprint. */
  catalogFingerprint: string;
  /**
   * Whether this Wait is entered here rather than handed to a branch run.
   * Only the wait strategy reads it.
   */
  entersInPlace: boolean;
  /** Hand a Wait to a durable branch run. Only the wait strategy calls it. */
  handOffBranch: () => Effect.Effect<NodeWorkOutcome, EngineFailure>;
};

export type NodeStrategy = {
  /** Stable id for spans and logs. */
  readonly id: string;
  run: (ctx: NodeWorkContext) => Effect.Effect<NodeWorkOutcome, EngineFailure>;
};

export type ActionStepInput = {
  actionType: string;
  config: Record<string, unknown>;
  outputs: NodeOutputs;
  context: NodeContext;
  store: WorkflowStore;
  actions: WorkflowActions;
  runtime: WorkflowExecutionRuntime;
  eventName: string | null;
  /** Published catalog fingerprint. */
  catalogFingerprint: string;
};
