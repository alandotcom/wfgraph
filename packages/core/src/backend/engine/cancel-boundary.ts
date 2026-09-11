/**
 * Where a run leaves the Started branch of the Lifecycle Node for the Canceled
 * one, and everything that decides whether it may. The claim on the execution
 * row is the whole authority, and the Canceled branch runs inside the same
 * Execution.
 */

import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import {
  LIFECYCLE_CANCELED_HANDLE,
  nodesBehindOutlet,
} from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import { configDeclaresCancelEvent } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { Effect } from "effect";
import type { EngineFailure } from "#src/backend/engine/engine-failure";
import { runDurable } from "#src/backend/engine/durable";
import type { WorkflowExecutionRuntime } from "#src/backend/engine/runtime";
import type { PendingCancel, WorkflowStore } from "#src/backend/engine/store";
import type { Traversal } from "#src/backend/engine/traversal";

export type CancelBoundaryInput = {
  /** The entry nodes this run started from. */
  lifecycleNodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  traversal: Traversal;
  runtime: WorkflowExecutionRuntime;
  store: WorkflowStore;
  executionId: string;
  /**
   * Whether this run may take the Canceled outlet itself. A branch run may not:
   * the run that started it is the one that routes a cancellation, so a second
   * reader of the flag would put two runs on the outlet.
   */
  routesCancellation: boolean;
};

/**
 * What a node's boundary read decided. `nextNodes` is the Canceled branch's own
 * first nodes, for the caller to run: the boundary names them and schedules
 * nothing itself, so the scheduler stays the one thing that runs a node.
 */
export type CancelSettlement = {
  entered: boolean;
  nextNodes: readonly string[];
};

export class CancelBoundary {
  private readonly input: CancelBoundaryInput;

  /**
   * A Cancel Event is the only thing that ever stamps the flag the boundary read
   * asks for, so a graph declaring none can never be flagged and buys neither
   * the durable step nor the query at any node. The answer comes from this run's
   * own graph, which the run carries in its Inngest event: a Cancel Event added
   * mid-run reaches the runs that start after it, not the ones already walking.
   */
  private readonly canBeCanceled: boolean;

  /**
   * Which side of the lifecycle a node sits on is a fact about the graph rather
   * than about how far this run got, so the boundary read reaches the same nodes
   * on a replay as on the attempt. A node inside the Canceled branch is asked
   * nothing: its run is already canceled, which is what makes a second Cancel
   * Event a no-op.
   */
  private readonly canceledBranchNodeIds: ReadonlySet<string>;

  /**
   * Set the moment the run leaves the Started branch for the Canceled one, and
   * read by every node that finishes after: a run on its way out schedules
   * nothing more on the branch it was walking.
   */
  private entered = false;

  /**
   * The Cancel Event that claimed this run, which the Canceled branch reads as
   * the Event it arrived on. Rebuilt on a replay along with `entered`, because
   * the boundary read is memoized and hands back the same claim.
   */
  private cancelEventName: string | null = null;

  /**
   * A boundary for a branch run (ADR-0011), which routes no cancellation of its
   * own: `settle` answers nothing at every node, so the run that started the
   * branch stays the one thing that takes the Canceled outlet.
   *
   * It keeps the graph-derived node set, because a branch still has to know
   * which side each of its nodes sits on: that is what a Canceled-side Wait's
   * park write is guarded with, and what holds a Started-side node back once
   * `carryClaim` has been called.
   */
  static forBranch(input: Omit<CancelBoundaryInput, "routesCancellation">) {
    return new CancelBoundary({ ...input, routesCancellation: false });
  }

  constructor(input: CancelBoundaryInput) {
    this.input = input;

    this.canBeCanceled =
      input.routesCancellation &&
      input.lifecycleNodes.some((node) =>
        configDeclaresCancelEvent(node.data.config)
      );

    this.canceledBranchNodeIds = nodesBehindOutlet({
      entryNodeIds: new Set(input.lifecycleNodes.map((node) => node.id)),
      outlet: LIFECYCLE_CANCELED_HANDLE,
      edges: input.edges,
    });
  }

  /** Whether the run has left the Started branch. */
  hasLeftStartedBranch(): boolean {
    return this.entered;
  }

  /**
   * Whether this node sits behind the Canceled outlet.
   *
   * Asked by anything holding a node back across the boundary, because a node
   * scheduled before the crossing and run after it would put the run back on
   * the branch it just left. The scheduler's deferred waits are the one such
   * queue.
   */
  isOnCanceledBranch(nodeId: string): boolean {
    return this.canceledBranchNodeIds.has(nodeId);
  }

  /**
   * The Cancel Event this run is now on, or null while it is still on the
   * Started branch and the Start Event is the answer.
   */
  canceledByEvent(): string | null {
    return this.cancelEventName;
  }

  /**
   * Asks whether a Cancel Event has claimed this run, and takes the Canceled
   * outlet if one has. A run that has left the Started branch schedules nothing
   * more on the branch it was walking, so the node that just finished stops on
   * `entered` and runs `nextNodes` instead.
   *
   * The read sits inside a step, so its answer is memoized per node: a replay
   * that asked the database again could route one attempt down the Started
   * branch and the next down the Canceled one, and the memoized node outputs
   * would then belong to neither.
   */
  settle(nodeId: string): Effect.Effect<CancelSettlement, EngineFailure> {
    if (!this.canBeCanceled || this.canceledBranchNodeIds.has(nodeId)) {
      return Effect.succeed({ entered: false, nextNodes: [] });
    }

    const { runtime, store, executionId } = this.input;
    return Effect.gen(
      function* (this: CancelBoundary) {
        const pending = yield* runDurable(
          runtime,
          // No node name reaches this class, and every check reads the same row,
          // so the label names the question rather than the node asking it.
          { id: `lifecycle-check-${nodeId}`, name: "Cancel check" },
          store.readPendingCancel(executionId)
        );

        // A boundary already crossed leaves nothing to schedule: the outlet's
        // nodes went to whichever node crossed it first.
        if (!pending || this.entered) {
          return { entered: this.entered, nextNodes: [] };
        }

        return {
          entered: true,
          nextNodes: yield* this.enter(pending),
        };
      }.bind(this)
    );
  }

  /**
   * Takes on the Cancel claim the run that started this branch already routed.
   *
   * Nothing is scheduled and nothing is logged: the run that started the branch
   * already did both.
   */
  carryClaim(claim: PendingCancel): void {
    this.adoptClaim(claim);
  }

  /**
   * Records the claim this run is now on and writes its payload over the entry
   * nodes' outputs, which is everything both the routing run and a branch run do
   * with a claim.
   *
   * A node below the Canceled outlet addresses the entry node in its templates,
   * and on that side the entry node's output is the payload the canceling Event
   * carried. The stored output the entry node's row holds is the Start Event's
   * payload, recorded before the claim landed.
   */
  private adoptClaim(claim: PendingCancel): void {
    this.entered = true;
    this.cancelEventName = claim.eventName;

    const { lifecycleNodes, traversal } = this.input;
    for (const lifecycleNode of lifecycleNodes) {
      traversal.setOutput(lifecycleNode.id, {
        label: lifecycleNode.data.label || lifecycleNode.id,
        data: claim.payload,
      });
    }
  }

  /**
   * Takes the Canceled outlet for a Cancel claim the caller has already read,
   * and answers with the branch's first nodes.
   *
   * A root run reads its claim once more after its Started branch has run out,
   * and a claim that landed after the last boundary read reaches the outlet
   * through here. A boundary already crossed answers with no nodes, because the
   * outlet's nodes went to whichever node crossed it.
   */
  enterClaimed(claim: PendingCancel): Effect.Effect<readonly string[]> {
    return this.entered ? Effect.succeed([]) : this.enter(claim);
  }

  /**
   * Routes the run into the Lifecycle Node's Canceled outlet, and answers with
   * the branch's first nodes.
   *
   * The branch runs inside the same Execution, so every node that already
   * landed keeps its output. An outlet with no edge leaves nothing to schedule,
   * and the run ends on the status alone.
   */
  private enter(pending: PendingCancel): Effect.Effect<readonly string[]> {
    return Effect.gen(
      function* (this: CancelBoundary) {
        this.adoptClaim(pending);

        const { lifecycleNodes, traversal } = this.input;

        const nextNodes: string[] = [];
        for (const lifecycleNode of lifecycleNodes) {
          // The entry node may not have scheduled anything yet, and the branch's
          // first node waits on it the way any node waits on its source.
          traversal.markReadyForDownstream(lifecycleNode.id);
          nextNodes.push(
            ...traversal.nextNodes(lifecycleNode.id, {
              kind: "outlet",
              outlet: LIFECYCLE_CANCELED_HANDLE,
            })
          );
        }

        yield* Effect.logInfo("Entering the Canceled outlet").pipe(
          Effect.annotateLogs({
            cancelEventName: pending.eventName,
            nextNodeIds: nextNodes,
          })
        );

        return nextNodes;
      }.bind(this)
    );
  }
}
