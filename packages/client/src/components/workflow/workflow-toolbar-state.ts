/**
 * The toolbar's page-lifetime capabilities and server reads.
 *
 * Authorization arrives in the bootstrap document before React mounts. This hook
 * turns that fixed snapshot into named toolbar capabilities and enables only the
 * reads their operations authorize.
 */

import { useQuery } from "@tanstack/react-query";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { can, canInspectWorkflowRuns } from "#src/lib/authorization";
import type { rpc } from "#src/lib/rpc-client";
import {
  integrationsQueryOptions,
  selectPublicationState,
  workflowListQueryOptions,
  workflowPublicationQueryOptions,
} from "#src/lib/rpc-query";
import {
  clearWorkflowAtom,
  edgesAtom,
  nodesAtom,
  type NodeDataUpdate,
  selectedNodeAtom,
  updateNodeDataAtom,
  canRedoAtom,
  canUndoAtom,
  redoAtom,
  undoAtom,
} from "#src/lib/workflow-graph-store";
import type {
  WorkflowEdge,
  WorkflowMode,
  WorkflowNode,
} from "#src/lib/workflow-graph-types";
import {
  currentWorkflowIdAtom,
  currentWorkflowModeAtom,
  currentWorkflowNameAtom,
  hasUnsavedChangesAtom,
  isSavingAtom,
} from "#src/lib/workflow-save-store";
import { isExecutingAtom, isGeneratingAtom } from "#src/lib/workflow-ui-store";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";

/** The operations that directly determine a workflow toolbar control. */
export type WorkflowToolbarCapabilities = Readonly<{
  canUpdate: boolean;
  canExecute: boolean;
  canReadRuns: boolean;
  canReadVersionHistory: boolean;
  canCompare: boolean;
  canCreate: boolean;
  canDuplicate: boolean;
  canDelete: boolean;
  canPublish: boolean;
  canReadVersionGraph: boolean;
}>;

export function readWorkflowToolbarCapabilities(): WorkflowToolbarCapabilities {
  return {
    canUpdate: can(WfGraphOperations.workflowUpdate.id),
    canExecute: can(WfGraphOperations.workflowExecute.id),
    canReadRuns: canInspectWorkflowRuns(),
    canReadVersionHistory: can(WfGraphOperations.workflowGetVersionHistory.id),
    canCompare: can(WfGraphOperations.workflowCompareVersion.id),
    canCreate: can(WfGraphOperations.workflowCreate.id),
    canDuplicate: can(WfGraphOperations.workflowDuplicate.id),
    canDelete: can(WfGraphOperations.workflowDelete.id),
    // Publish compares the draft before opening its review. The same capability
    // therefore covers the button and its comparison request.
    canPublish:
      can(WfGraphOperations.workflowPublish.id) &&
      can(WfGraphOperations.workflowCompareVersion.id),
    canReadVersionGraph: can(WfGraphOperations.workflowGetVersionGraph.id),
  };
}

/** Every workflow the switcher lists, as `workflow.getAll` answers it. */
type WorkflowSummaries = Awaited<ReturnType<typeof rpc.workflow.getAll>>;

/** Every connection the operator has, as `integration.getAll` answers it. */
type UserIntegrations = Awaited<ReturnType<typeof rpc.integration.getAll>>;

/**
 * What the toolbar, its command palette, and its handlers read for one
 * workflow.
 *
 * The ten capability flags are `WorkflowToolbarCapabilities`, which
 * `readWorkflowToolbarCapabilities` fills in; the fields declared here are the
 * canvas, the workflow's own identity and mode, the publication badge's server
 * read, and the writers each control calls.
 */
export type WorkflowToolbarState = WorkflowToolbarCapabilities & {
  /** The saved workflow's id, null until a draft has been saved once. */
  currentWorkflowId: string | null;
  workflowName: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  allWorkflows: WorkflowSummaries;
  userIntegrations: UserIntegrations;

  workflowMode: WorkflowMode;
  setCurrentWorkflowMode: (mode: WorkflowMode) => void;

  // Work already in flight, which every write control is disabled on.
  isExecuting: boolean;
  isGenerating: boolean;
  isSaving: boolean;
  hasUnsavedChanges: boolean;

  /** The publication badge's fields, undefined until the query answers. */
  publication: ReturnType<typeof selectPublicationState> | undefined;

  // The writers behind the toolbar's controls.
  setIsExecuting: (value: boolean) => void;
  clearWorkflow: () => void;
  updateNodeData: (update: NodeDataUpdate) => void;
  setSelectedNodeId: (id: string | null) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
};

export function useWorkflowToolbarState(): WorkflowToolbarState {
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const [isExecuting, setIsExecuting] = useAtom(isExecutingAtom);
  const [isGenerating] = useAtom(isGeneratingAtom);
  const clearWorkflow = useSetAtom(clearWorkflowAtom);
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const [currentWorkflowId] = useAtom(currentWorkflowIdAtom);
  const workflowName = useAtomValue(currentWorkflowNameAtom);
  const [workflowMode, setCurrentWorkflowMode] = useAtom(
    currentWorkflowModeAtom
  );
  const capabilities = readWorkflowToolbarCapabilities();
  const isSaving = useAtomValue(isSavingAtom);
  const hasUnsavedChanges = useAtomValue(hasUnsavedChangesAtom);
  const undo = useSetAtom(undoAtom);
  const redo = useSetAtom(redoAtom);
  const [canUndo] = useAtom(canUndoAtom);
  const [canRedo] = useAtom(canRedoAtom);
  const setSelectedNodeId = useSetAtom(selectedNodeAtom);
  const { data: userIntegrations = [] } = useQuery({
    ...integrationsQueryOptions(),
    enabled: can(WfGraphOperations.integrationGetAll.id),
  });
  const { data: allWorkflows = [] } = useQuery({
    ...workflowListQueryOptions(),
    enabled: can(WfGraphOperations.workflowGetAll.id),
  });
  const { data: publication } = useQuery({
    ...workflowPublicationQueryOptions(currentWorkflowId ?? ""),
    enabled: Boolean(currentWorkflowId),
  });

  return {
    nodes,
    edges,
    isExecuting,
    setIsExecuting,
    isGenerating,
    clearWorkflow,
    updateNodeData,
    currentWorkflowId,
    workflowName,
    workflowMode,
    setCurrentWorkflowMode,
    ...capabilities,
    isSaving,
    hasUnsavedChanges,
    undo,
    redo,
    canUndo,
    canRedo,
    allWorkflows,
    setSelectedNodeId,
    userIntegrations,
    publication,
  };
}
