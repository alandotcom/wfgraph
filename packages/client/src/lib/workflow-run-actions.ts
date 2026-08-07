/**
 * Run-time side of the toolbar: status animation, remembering the test payload,
 * and turning an execute response into canvas + toast state.
 *
 * Issue collection lives in `@rova/shared/graph/workflow-issues`; this module
 * only drives a run once the builder has cleared (or bypassed) those checks.
 */

import { toast } from "sonner";
import { getClientLogger } from "#src/lib/logger";
import type { TestRunRequest } from "#src/components/overlays/test-run-overlay";
import type { WorkflowExecuteResult } from "#src/lib/rpc-client";
import type {
  WorkflowNode,
  WorkflowNodeData,
} from "#src/lib/workflow-graph-types";
import type { WorkflowExecutionIgnoredReason } from "@rova/shared/lifecycle/execution-contracts";
import {
  findEntryNode,
  nextTestPayloads,
  readEntryTestPayloads,
} from "#src/lib/test-payload";

// The `satisfies` is the exhaustiveness check: a reason added to the shared
// union fails to compile here until it has user-facing copy.
const logger = getClientLogger("workflow", "run");

export const IGNORED_REASON_MESSAGES = {
  workflow_paused: "Workflow is paused and cannot start new runs.",
  concurrency_first_wins:
    "A run for this entity is already going, and this workflow keeps the first one.",
  entity_value_missing:
    "This payload carries nothing at the workflow's Correlation Path, and its Concurrency needs an entity to compare.",
  manual_start_not_allowed:
    "This workflow does not list manual runs as a start source.",
  start_event_required:
    "This workflow splits on the Event a run is on, so a run has to name one.",
} satisfies Record<WorkflowExecutionIgnoredReason, string>;

/** The graph store's node writer, as everything in this file passes it around. */
export type UpdateNodeData = (update: {
  id: string;
  data: Partial<WorkflowNodeData>;
}) => void;

export function updateNodesStatus(
  nodes: WorkflowNode[],
  updateNodeData: UpdateNodeData,
  status: "idle" | "running" | "success" | "error" | "cancelled"
) {
  for (const node of nodes) {
    updateNodeData({ id: node.id, data: { status } });
  }
}

/**
 * Keeps this run's payload on the entry node, so the Test Run overlay opens on
 * it next time. The write goes through the graph store, which is what the
 * autosave queue watches.
 */
export function rememberTestPayload(input: {
  nodes: WorkflowNode[];
  updateNodeData: UpdateNodeData;
  request: TestRunRequest;
}) {
  const entryNode = findEntryNode(input.nodes);
  if (!entryNode) {
    return;
  }

  input.updateNodeData({
    id: entryNode.id,
    data: {
      config: {
        ...entryNode.data.config,
        testPayloads: nextTestPayloads(
          readEntryTestPayloads(input.nodes),
          input.request
        ),
      },
    },
  });
}

type ExecuteWorkflowRunParams = {
  /** The run mutation, with its variables already bound by the caller. */
  runWorkflow: () => Promise<WorkflowExecuteResult>;
  nodes: WorkflowNode[];
  updateNodeData: UpdateNodeData;
  setIsExecuting: (value: boolean) => void;
  /**
   * Opens the new run in the URL, which is what the Runs panel and the
   * canvas overlay both read (#33). Called only once a run has actually
   * started: the ignored and error paths below leave the URL exactly where
   * it stood, since neither one created an execution for it to point at.
   */
  navigateToExecution: (executionId: string) => Promise<void>;
};

export async function executeWorkflowRun({
  runWorkflow,
  nodes,
  updateNodeData,
  setIsExecuting,
  navigateToExecution,
}: ExecuteWorkflowRunParams) {
  updateNodesStatus(nodes, updateNodeData, "idle");

  // Instant visual feedback before the first poll lands.
  for (const node of nodes) {
    if (node.data.type === "lifecycle") {
      updateNodeData({ id: node.id, data: { status: "running" } });
    }
  }

  try {
    const result = await runWorkflow();

    if (result.status !== "running" || !result.executionId) {
      toast.message(
        result.status === "ignored"
          ? IGNORED_REASON_MESSAGES[result.reason]
          : "Execution completed without starting a new run."
      );

      // No execution was created, so there is no id for the URL to own.
      // Whatever run was already open (or not) is left as it stands.
      setIsExecuting(false);
      updateNodesStatus(nodes, updateNodeData, "idle");
      return;
    }

    if (
      typeof result.supersededExecutions === "number" &&
      result.supersededExecutions > 0
    ) {
      const failed = Array.isArray(result.failedToSupersede)
        ? result.failedToSupersede.length
        : 0;
      const superseded = `Superseded ${result.supersededExecutions} run${result.supersededExecutions === 1 ? "" : "s"} for this entity and started a new one.`;

      if (failed > 0) {
        // A run the engine could not signal keeps going against the entity the
        // new one is now working on, which is the duplicate work newest-wins
        // exists to prevent. It reads as routine in the same tone as the success.
        toast.error(
          `${superseded} ${failed} could not be signalled and may still be running. Cancel them from the Runs panel.`
        );
      } else {
        toast.success(superseded);
      }
    }

    // The URL is the one writer of which run is open; the Runs panel and the
    // canvas overlay both derive their selection from it.
    await navigateToExecution(result.executionId);
  } catch (error) {
    // The mutation cache has already toasted the message. What is left is the
    // canvas, which still shows the Lifecycle Node running.
    logger.error("Failed to execute the workflow", { error });
    updateNodesStatus(nodes, updateNodeData, "error");
    setIsExecuting(false);
  }
}
