/**
 * Which run node's evidence the open run shows, and the writes that choose it.
 * The node and its chosen execution live in the run address's navigation; the
 * element that opened the evidence and the focus Browse owes it are UI atoms.
 */

import { useNavigate } from "@tanstack/react-router";
import { atom, useAtomValue, useSetAtom, useStore } from "jotai";
import type {
  ExecutionEvent,
  ExecutionLog,
  ExecutionWait,
  WorkflowExecution,
} from "#src/lib/execution-logs";
import {
  buildRunNodeEvidence,
  type PinnedGraphState,
  runEvidenceNodeId,
  type RunNodeEvidence,
} from "#src/lib/run-node-evidence";
import { executionOverlayGraphAtom } from "#src/lib/workflow-graph-store";
import {
  type OpenRevealLevel,
  scopeId,
  scopeOfNode,
  type WorkspaceAddress,
  workspaceAddressId,
  workspaceRouteSearch,
} from "#src/lib/workflow-navigation-state";
import {
  activeChosenExecutionAtom,
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
  chooseRunExecutionAtom,
  inspectRunNodeAtom,
} from "#src/lib/workflow-workspace-navigation";
import { requestRevealPlacementAtom } from "./canvas-reveal/reveal-requests";

/**
 * What opened a run node's evidence in one address: a journey entry, named by
 * its log id, or the canvas node itself, with a null `logId`.
 * `closedReopenLevel` is set when a canvas click opened Focus straight from a
 * closed Canvas Reveal, and holds the level Reveal reopened at before it.
 */
type RunEvidenceOrigin = {
  addressId: string;
  nodeId: string;
  logId: string | null;
  closedReopenLevel: OpenRevealLevel | null;
};

/** The element that last opened run node evidence, or null. */
export const runEvidenceOriginAtom = atom<RunEvidenceOrigin | null>(null);

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
 * The evidence of the node the open run shows, or null when it shows none or
 * no run is open. The Runs header and body call it with the same reads, so
 * both show one value.
 */
export function useRunNodeEvidence(
  reads: RunEvidenceReads | null
): RunNodeEvidence | null {
  const selection = useAtomValue(activeSelectionAtom);
  const chosenExecution = useAtomValue(activeChosenExecutionAtom);
  const nodes = useAtomValue(executionOverlayGraphAtom)?.nodes ?? [];
  const nodeId = runEvidenceNodeId({ selection, chosenExecution, nodes });
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
 * Show a node's evidence from outside the canvas, as a journey entry does, with
 * that entry's execution chosen. A node in the pinned graph is selected in the
 * scope that shows it: a Group member on its Group's focused canvas, reached by
 * pushing that scope's route. A node the pinned graph lacks, or any node while
 * that graph loads, is carried by the chosen execution with nothing selected.
 */
export function useInspectRunLog(): (
  log: ExecutionLog,
  options: { opensFocus: boolean }
) => void {
  const store = useStore();
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  const requestPlacement = useSetAtom(requestRevealPlacementAtom);
  return (log, options) => {
    const active = store.get(activeWorkspaceAddressAtom);
    const nodes = store.get(executionOverlayGraphAtom)?.nodes ?? [];
    const inGraph = nodes.some((node) => node.id === log.nodeId);
    const scope = scopeOfNode(nodes, log.nodeId);
    const address: WorkspaceAddress =
      inGraph && scopeId(scope) !== scopeId(active.scope)
        ? { ...active, scope }
        : active;
    store.set(runEvidenceOriginAtom, {
      addressId: workspaceAddressId(address),
      nodeId: log.nodeId,
      logId: log.id,
      closedReopenLevel: null,
    });
    store.set(inspectRunNodeAtom, {
      address,
      nodeId: log.nodeId,
      executionLogId: log.id,
      selectsNode: inGraph,
      opensFocus: options.opensFocus,
    });
    if (address !== active) {
      requestPlacement({
        addressId: workspaceAddressId(address),
        nodeIds: [log.nodeId],
      });
      void navigate({ search: workspaceRouteSearch(address) });
    }
  };
}

/** Choose which recorded execution of `nodeId` the evidence shows. */
export function useChooseRunExecution(): (
  nodeId: string,
  logId: string
) => void {
  const choose = useSetAtom(chooseRunExecutionAtom);
  return (nodeId, logId) => choose({ nodeId, logId });
}
