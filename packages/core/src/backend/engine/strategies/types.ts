/**
 * What a node strategy needs from the run, and what it reports back.
 *
 * The scheduler owns deferral, drain, branch hand-off, and post-success routing
 * via `routeAfterStrategy`. Strategies own the work of one node kind.
 */

import type { WorkflowActions } from "#src/backend/engine/actions";
import type { EntityTemplateContext } from "#src/backend/engine/entities";
import type { ExecutionResult } from "#src/backend/engine/contracts";
import type { WorkflowExecutionRuntime } from "#src/backend/engine/runtime";
import type { NodeContext } from "#src/backend/engine/step-log";
import type { WorkflowStore } from "#src/backend/engine/store";
import type {
  NodeOutputInGraphOrder,
  Traversal,
} from "#src/backend/engine/traversal";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import type { ExecutionSide } from "@wfgraph/shared/lifecycle/execution-contracts";
import type { JsonObject } from "@wfgraph/shared/types/json";
import type { Effect } from "effect";
import type { EngineFailure } from "#src/backend/engine/engine-failure";

/**
 * What a node's work left: an outcome, or a Wait still parked.
 *
 * A parked Wait has no outcome yet. The scheduler leaves the node unfinished
 * and schedules nothing below it, and the next pass of the body enters it again.
 */
export type NodeWorkOutcome = SettledNodeWork | { status: "parked" };

export type SettledNodeWork = {
  status: "settled";
  result: ExecutionResult;
  /** Action node without an actionType: recorded as failed, no output stored. */
  unconfigured?: boolean | undefined;
  /**
   * The branch a Condition node picked. Absent on every other node, and absent
   * on a disabled Condition node, which evaluated nothing and halts its branch
   * where it stands.
   */
  conditionValue?: boolean | undefined;
  /**
   * The Event an Event Split routed by, as its memoized route step stored it.
   * Absent on every other node; null where the branch named no Event, which
   * matches no outlet.
   */
  routedEvent?: string | null | undefined;
  /**
   * Whether the run stops below this node. A Wait that was skipped or woken by
   * a cancel says so, a disabled routing node says so, and a branch that was
   * handed to a durable run of its own says so because that run already walked
   * everything underneath.
   */
  haltBranch?: boolean | undefined;
  /** A durable child reported execution-wide Exit before entering this node. */
  executionExited?: boolean | undefined;
  /**
   * How this node changes the Arriving Event its branch carries below it.
   * Absent means leave it. `null` means the branch names none below this node
   * (a timeout that continues past an event-mode Wait). A named Event replaces
   * the branch's, and its payload is what the nodes below read where they
   * address the entry node.
   */
  arrivingEvent?: { eventName: string; payload: JsonObject } | null | undefined;
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
  /** The Workflow Version whose graph this run is walking. */
  workflowVersionId: string;
  runMode: "live" | "test";
  startPayload: JsonObject;
  /** Current Entity values referenced by this node, keyed by field path. */
  entityContext?: EntityTemplateContext | undefined;
  /** Event the nodes running now arrived on. */
  eventName: string | null;
  /** Published catalog fingerprint. */
  catalogFingerprint: string;
  /**
   * Which side of the Lifecycle Node this node sits on, read off the graph. The
   * wait strategy passes it to every write that parks or resumes the run, which
   * is what lets a Wait behind the Canceled outlet park after a Cancel claim.
   */
  side: ExecutionSide;
};

export type NodeStrategy = {
  /** Stable id for spans and logs. */
  readonly id: string;
  run: (
    context: NodeWorkContext
  ) => Effect.Effect<NodeWorkOutcome, EngineFailure>;
};

export type ActionStepInput = {
  actionType: string;
  config: Record<string, unknown>;
  /**
   * Every finished node's output in the graph's node order, which is the
   * order a Condition folds them into its namespace, each beside the id a
   * node-qualified rule names it by.
   */
  outputsInGraphOrder: readonly NodeOutputInGraphOrder[];
  context: NodeContext;
  store: WorkflowStore;
  actions: WorkflowActions;
  runtime: WorkflowExecutionRuntime;
  eventName: string | null;
  /** Current tracked Entity values referenced by this action node. */
  entityContext?: EntityTemplateContext | undefined;
  /** Published catalog fingerprint. */
  catalogFingerprint: string;
};
