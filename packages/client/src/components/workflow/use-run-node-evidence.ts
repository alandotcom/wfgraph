/**
 * Which run node's evidence the open run shows, and the writes that choose it.
 * The node and its chosen execution live in the run address's navigation. The
 * focus Browse owes the evidence is a UI atom, and `run-evidence-origin.ts`
 * holds what opened it.
 */

import { useNavigate } from "@tanstack/react-router";
import { atom, useAtomValue, useSetAtom, useStore } from "jotai";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import {
  type GroupRunSummary,
  summarizeGroupRun,
} from "@wfgraph/shared/graph/group-run-status";
import type {
  ExecutionEvent,
  ExecutionLog,
  ExecutionWait,
  WorkflowExecution,
} from "#src/lib/execution-logs";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import {
  buildRunNodeEvidence,
  type PinnedGraphState,
  type RunNodeEvidence,
} from "#src/lib/run-node-evidence";
import {
  executionOverlayGraphAtom,
  projectedRunStatusAtom,
  runNodeEvidenceStatusesAtom,
} from "#src/lib/workflow-graph-store";
import { scopeOfNode } from "#src/lib/workflow-scope-graph";
import {
  scopeId,
  type WorkspaceAddress,
  workspaceAddressId,
  workspaceRouteSearch,
} from "#src/lib/workflow-navigation-state";
import {
  activeChosenExecutionAtom,
  activeWorkspaceAddressAtom,
  chooseRunExecutionAtom,
} from "#src/lib/workflow-workspace-navigation";
import { requestRevealPlacementAtom } from "./canvas-reveal/reveal-requests";
import { useRevealNavigation } from "./canvas-reveal/use-reveal-navigation";
import { runEvidenceOriginAtom } from "./run-evidence-origin";

/**
 * Where DOM focus goes the next time Runs Browse shows the open run: a journey
 * entry by log id, or the canvas node when `logId` is null. Leaving Focus sets
 * it, and Browse clears it once it has moved focus.
 */
export const runBrowseFocusRequestAtom = atom<{
  nodeId: string;
  logId: string | null;
} | null>(null);

/** The reads of one open run that its node evidence is built from. */
export type RunEvidenceReads = {
  execution: WorkflowExecution;
  logs: readonly ExecutionLog[];
  waits: readonly ExecutionWait[];
  events: readonly ExecutionEvent[];
  pinnedGraph: PinnedGraphState;
};

/**
 * The evidence of `nodeId` in the open run, or null for a null `nodeId` or when
 * no run is open. The Runs header and body call it with the node their subject
 * targets and the same reads, so both show one value.
 */
export function useRunNodeEvidence(
  reads: RunEvidenceReads | null,
  nodeId: string | null
): RunNodeEvidence | null {
  const chosenExecution = useAtomValue(activeChosenExecutionAtom);
  const nodes = useAtomValue(executionOverlayGraphAtom)?.nodes ?? [];
  if (nodeId === null || reads === null) {
    return null;
  }
  return buildRunNodeEvidence({
    nodeId,
    execution: reads.execution,
    logs: reads.logs,
    waits: reads.waits,
    events: reads.events,
    nodes,
    pinnedGraph: reads.pinnedGraph,
    chosenExecution,
  });
}

/**
 * The run summary of the Group frame `groupId` in the open run, or null outside
 * Runs, for an id the pinned graph holds no Group frame for, and before the
 * run's status is projected. It counts from the page's run status projection,
 * the same per-node statuses the step cards paint.
 */
export function useRunGroupSummary(
  groupId: string | null
): GroupRunSummary | null {
  const view = useAtomValue(workflowWorkspaceViewAtom);
  const graph = useAtomValue(executionOverlayGraphAtom);
  const evidence = useAtomValue(runNodeEvidenceStatusesAtom);
  const executionStatus = useAtomValue(projectedRunStatusAtom);
  if (
    view !== "runs" ||
    groupId === null ||
    graph === null ||
    executionStatus === null ||
    !isGroupNode(graph.nodes.find((node) => node.id === groupId))
  ) {
    return null;
  }
  return summarizeGroupRun({
    groupId,
    nodes: graph.nodes,
    edges: graph.edges,
    evidence,
    executionStatus,
  });
}

/**
 * Show a run node's evidence from outside the canvas, in Canvas Reveal Focus or
 * the mobile evidence inspector. A node in the pinned graph is selected in the
 * scope that shows it: a Group member on its Group's focused canvas, reached by
 * pushing that scope's route. A node the pinned graph lacks, or any node while
 * that graph loads, is carried by the chosen execution with nothing selected. A
 * null `logId` chooses no execution, so the latest shows, and marks the canvas
 * node as what opened the evidence.
 */
export function useInspectRunNode(): (input: {
  nodeId: string;
  logId: string | null;
}) => void {
  const store = useStore();
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  const navigation = useRevealNavigation();
  const requestPlacement = useSetAtom(requestRevealPlacementAtom);
  return ({ nodeId, logId }) => {
    const active = store.get(activeWorkspaceAddressAtom);
    const nodes = store.get(executionOverlayGraphAtom)?.nodes ?? [];
    const inGraph = nodes.some((node) => node.id === nodeId);
    const scope = scopeOfNode(nodes, nodeId);
    const address: WorkspaceAddress =
      inGraph && scopeId(scope) !== scopeId(active.scope)
        ? { ...active, scope }
        : active;
    store.set(runEvidenceOriginAtom, {
      addressId: workspaceAddressId(address),
      nodeId,
      logId,
      closedReopenLevel: null,
    });
    navigation.inspectRunNode({
      address,
      nodeId,
      executionLogId: logId,
      selectsNode: inGraph,
      opensEvidence: true,
    });
    if (address !== active) {
      requestPlacement({
        addressId: workspaceAddressId(address),
        nodeIds: [nodeId],
      });
      void navigate({ search: workspaceRouteSearch(address) });
    }
  };
}

/**
 * Show a node's evidence from its journey entry, with that entry's execution
 * chosen, as `useInspectRunNode` shows any run node.
 */
export function useInspectRunLog(): (log: ExecutionLog) => void {
  const inspectNode = useInspectRunNode();
  return (log) => inspectNode({ nodeId: log.nodeId, logId: log.id });
}

/** Choose which recorded execution of `nodeId` the evidence shows. */
export function useChooseRunExecution(): (
  nodeId: string,
  logId: string
) => void {
  const choose = useSetAtom(chooseRunExecutionAtom);
  return (nodeId, logId) => choose({ nodeId, logId });
}
