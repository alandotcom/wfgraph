/**
 * Toolbar behaviour: save/create, pre-run issue collection, execute, and the
 * workflow-level menu actions. Chrome components live beside this file; run
 * animation and payload memory live in `workflow-run-actions`.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import { toast } from "sonner";
import { ConfirmOverlay } from "#src/components/overlays/confirm-overlay";
import {
  TestRunOverlay,
  type TestRunRequest,
} from "#src/components/overlays/test-run-overlay";
import { WorkflowIssuesOverlay } from "#src/components/overlays/workflow-issues-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { useDeleteWorkflow } from "#src/hooks/use-delete-workflow";
import { useGoToStep } from "#src/hooks/use-workflow-issues";
import { useDomEvent } from "#src/hooks/effects";
import { isTextEntry } from "#src/lib/is-text-entry";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import {
  cacheWorkflowPublication,
  integrationsQueryOptions,
  orpcQuery,
  refreshRunHistory,
  refreshWorkflowList,
  workflowListQueryOptions,
} from "#src/lib/rpc-query";
import {
  clearGraphSelectionAtom,
  clearWorkflowAtom,
  edgesAtom,
  executionOverlayGraphAtom,
  nodesAtom,
  selectedNodeAtom,
  setNodeStatusesAtom,
  updateNodeDataAtom,
  canRedoAtom,
  canUndoAtom,
  redoAtom,
  undoAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  executeWorkflowRun,
  rememberTestPayload,
  type UpdateNodeData,
} from "#src/lib/workflow-run-actions";
import {
  createWorkflowAtom,
  currentWorkflowIdAtom,
  currentWorkflowModeAtom,
  currentWorkflowNameAtom,
  hasUnsavedChangesAtom,
  isSavingAtom,
  isWorkflowOwnerAtom,
  saveWorkflowAtom,
  setWorkflowModeAtom,
} from "#src/lib/workflow-save-store";
import { toSerializedGraph } from "#src/lib/rpc-client";
import {
  isExecutingAtom,
  isGeneratingAtom,
  isTransitioningFromHomepageAtom,
  propertiesPanelActiveTabAtom,
} from "#src/lib/workflow-ui-store";
import {
  readEntryLifecycleRules,
  readEntryTestPayloads,
} from "#src/lib/test-payload";
import { isEventSplitNode } from "@wfgraph/shared/lifecycle/event-split";
import {
  initialLifecycleRules,
  manualStartAllowed,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";
import {
  collectWorkflowIssues,
  groupWorkflowIssuesForOverlay,
  hasBlockingWorkflowIssues,
} from "@wfgraph/shared/graph/workflow-issues";
import { toPersistedNodes } from "#src/lib/workflow-graph-types";

type WorkflowHandlerParams = {
  currentWorkflowId: string | null;
  workflowName: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  updateNodeData: UpdateNodeData;
  isExecuting: boolean;
  setIsExecuting: (value: boolean) => void;
  setCurrentWorkflowName: (name: string) => void;
  setIsTransitioningFromHomepage: (value: boolean) => void;
  setActiveTab: (value: string) => void;
  setSelectedNodeId: (id: string | null) => void;
  userIntegrations: Array<{ id: string; type: string }>;
};

function useWorkflowHandlers({
  currentWorkflowId,
  workflowName,
  nodes,
  edges,
  updateNodeData,
  isExecuting,
  setIsExecuting,
  setCurrentWorkflowName,
  setIsTransitioningFromHomepage,
  setActiveTab,
  setSelectedNodeId,
  userIntegrations,
}: WorkflowHandlerParams) {
  const catalog = useExtensionCatalog();
  // The same implementation the status strip's issue count reaches for, so
  // "Fix" means one thing wherever the list was opened from. The hook is
  // instantiated per caller and each instance owns its own pending-focus state;
  // that state is write-then-consume within a single click, so only the
  // instance whose overlay was clicked ever holds one.
  const handleGoToStep = useGoToStep();
  const { open: openOverlay } = useOverlay();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const clearGraphSelection = useSetAtom(clearGraphSelectionAtom);
  const setExecutionOverlay = useSetAtom(executionOverlayGraphAtom);
  const setNodeStatuses = useSetAtom(setNodeStatusesAtom);
  const saveWorkflow = useSetAtom(saveWorkflowAtom);
  const createWorkflow = useSetAtom(createWorkflowAtom);
  // No errorMessage: a rejected run carries a server message worth reading, and
  // the mutation cache falls back to it. Every other outcome arrives as a
  // successful response with a status on it, which executeWorkflowRun reads.
  const runWorkflow = useMutation(
    orpcQuery.workflow.execute.mutationOptions({
      // A started run belongs in both run lists, and the dashboard's is the one
      // nobody is looking at when this fires.
      onSuccess: () => refreshRunHistory(queryClient),
    })
  );

  /**
   * Save the draft, creating the workflow if this canvas has never been one.
   *
   * Nothing calls this. Its only caller was the toolbar's Save button, which
   * autosave made pointless, and the editor route's Cmd+S has its own smaller
   * save that skips the name checks below. knip does not see it, because a
   * property of a returned object is not an unused export.
   *
   * It is left standing rather than deleted because the create branch is the
   * only writer of `isTransitioningFromHomepageAtom`, which the canvas still
   * reads for its opening viewport: removing this means rewriting that, and
   * that is a different change from this one.
   */
  const handleSave = async () => {
    // The `add` node is a placeholder, so a canvas holding only one has nothing
    // worth saving. The save itself strips it; this is the emptiness check.
    if (!nodes.some((node) => node.type !== "add")) {
      toast.error("Add at least one step before saving.");
      return;
    }

    const trimmedWorkflowName = workflowName.trim();
    if (!trimmedWorkflowName) {
      toast.error("Workflow name is required.");
      return;
    }

    // The save queue drives the saving indicator, so there is nothing to
    // bracket here — it already covers autosaves this handler never sees.
    if (currentWorkflowId) {
      const outcome = await saveWorkflow(
        { name: trimmedWorkflowName, nodes, edges },
        { immediate: true }
      );

      if (outcome && !outcome.ok) {
        toast.error(
          outcome.error.message || "Failed to save workflow. Please try again."
        );
        return;
      }

      setCurrentWorkflowName(trimmedWorkflowName);
      return;
    }

    // Creating adopts the new workflow's identity inside the save store.
    const outcome = await createWorkflow({
      name: trimmedWorkflowName,
      nodes,
      edges,
    });

    if (!outcome.ok) {
      toast.error(
        outcome.error.message || "Failed to save workflow. Please try again."
      );
      return;
    }

    setIsTransitioningFromHomepage(true);
    await navigate({
      to: "/workflows/$workflowId",
      params: { workflowId: outcome.workflow.id },
      replace: true,
    });
  };

  const executeWorkflow = async (request: TestRunRequest) => {
    if (!currentWorkflowId) {
      toast.error("Please save the workflow before executing");
      return;
    }

    // The sample is kept on the entry node, so the next run of this workflow
    // opens on what this one sent. Autosave carries it; the run itself travels
    // on the request and waits for no save.
    rememberTestPayload({ nodes, updateNodeData, request });

    // Switch to Runs tab when starting a run
    setActiveTab("runs");

    // Drop any run overlay so optimistic status and the new selection paint the
    // draft until the new run's pinned graph arrives.
    setExecutionOverlay(null);

    // Deselect all nodes and edges
    clearGraphSelection();
    setSelectedNodeId(null);

    setIsExecuting(true);
    await executeWorkflowRun({
      runWorkflow: () =>
        runWorkflow.mutateAsync({
          workflowId: currentWorkflowId,
          input: request.input,
          ...(request.eventName ? { eventName: request.eventName } : {}),
        }),
      nodes,
      setNodeStatuses,
      setIsExecuting,
      // The URL is the one writer of which run is open; workflow-runs.tsx
      // derives the selection atom and the pinned-graph overlay from it.
      navigateToExecution: (executionId) =>
        navigate({
          to: "/workflows/$workflowId",
          params: { workflowId: currentWorkflowId },
          search: { executionId },
        }),
    });
    // Don't set executing to false here - let polling handle it
  };

  const openTestRunOverlay = () => {
    const rules = readEntryLifecycleRules(nodes) ?? initialLifecycleRules;

    openOverlay(TestRunOverlay, {
      startEvents: rules.startEvents,
      allowManualStart: manualStartAllowed(rules),
      hasEventSplit: nodes.some(isEventSplitNode),
      savedPayloads: readEntryTestPayloads(nodes),
      onRun: (request: TestRunRequest) => {
        void executeWorkflow(request);
      },
    });
  };

  const handleExecute = async () => {
    // Guard against concurrent executions
    if (isExecuting) {
      return;
    }

    const issues = collectWorkflowIssues({
      nodes: toPersistedNodes(nodes),
      catalog,
      integrations: userIntegrations,
    });

    if (issues.length > 0) {
      const hasBlocking = hasBlockingWorkflowIssues(issues);
      openOverlay(WorkflowIssuesOverlay, {
        issues: groupWorkflowIssuesForOverlay(issues),
        onGoToStep: handleGoToStep,
        onRunAnyway: hasBlocking ? undefined : openTestRunOverlay,
        allowRunAnyway: !hasBlocking,
      });
      return;
    }

    openTestRunOverlay();
  };

  return {
    handleSave,
    handleExecute,
    handleGoToStep,
  };
}

export function useWorkflowState() {
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const [isExecuting, setIsExecuting] = useAtom(isExecutingAtom);
  const [isGenerating] = useAtom(isGeneratingAtom);
  const clearWorkflow = useSetAtom(clearWorkflowAtom);
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const [currentWorkflowId] = useAtom(currentWorkflowIdAtom);
  const [workflowName, setCurrentWorkflowName] = useAtom(
    currentWorkflowNameAtom
  );
  const [workflowMode, setCurrentWorkflowMode] = useAtom(
    currentWorkflowModeAtom
  );
  const setIsTransitioningFromHomepage = useSetAtom(
    isTransitioningFromHomepageAtom
  );
  const isOwner = useAtomValue(isWorkflowOwnerAtom);
  const isSaving = useAtomValue(isSavingAtom);
  const hasUnsavedChanges = useAtomValue(hasUnsavedChangesAtom);
  const undo = useSetAtom(undoAtom);
  const redo = useSetAtom(redoAtom);
  const [canUndo] = useAtom(canUndoAtom);
  const [canRedo] = useAtom(canRedoAtom);
  const setActiveTab = useSetAtom(propertiesPanelActiveTabAtom);
  const setSelectedNodeId = useSetAtom(selectedNodeAtom);
  const { data: userIntegrations = [] } = useQuery(integrationsQueryOptions());

  const { data: allWorkflows = [] } = useQuery(workflowListQueryOptions());

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
    setCurrentWorkflowName,
    setCurrentWorkflowMode,
    setIsTransitioningFromHomepage,
    isOwner,
    isSaving,
    hasUnsavedChanges,
    undo,
    redo,
    canUndo,
    canRedo,
    allWorkflows,
    setActiveTab,
    setSelectedNodeId,
    userIntegrations,
  };
}

export type WorkflowToolbarState = ReturnType<typeof useWorkflowState>;

export function useWorkflowActions(state: WorkflowToolbarState) {
  const catalog = useExtensionCatalog();
  const { open: openOverlay } = useOverlay();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const deleteWorkflow = useDeleteWorkflow();
  const setWorkflowMode = useSetAtom(setWorkflowModeAtom);
  const {
    currentWorkflowId,
    workflowName,
    workflowMode,
    setCurrentWorkflowName,
    setCurrentWorkflowMode,
    setIsTransitioningFromHomepage,
    nodes,
    edges,
    updateNodeData,
    isExecuting,
    setIsExecuting,
    clearWorkflow,
    setActiveTab,
    setSelectedNodeId,
    userIntegrations,
  } = state;

  const { handleSave, handleExecute, handleGoToStep } = useWorkflowHandlers({
    currentWorkflowId,
    workflowName,
    nodes,
    edges,
    updateNodeData,
    isExecuting,
    setIsExecuting,
    setCurrentWorkflowName,
    setIsTransitioningFromHomepage,
    setActiveTab,
    setSelectedNodeId,
    userIntegrations,
  });

  // Cmd+Enter runs the workflow. The listener lives here, beside handleExecute,
  // so the shortcut and the Run button are the same call rather than a store
  // round trip for something one function call away.
  //
  // Capture phase, because a focused node in the canvas would otherwise get the
  // keystroke first.
  const handleRunShortcut = useCallback(
    (event: KeyboardEvent) => {
      if (!((event.metaKey || event.ctrlKey) && event.key === "Enter")) {
        return;
      }
      if (isTextEntry(event.target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void handleExecute();
    },
    [handleExecute]
  );

  useDomEvent(document, "keydown", handleRunShortcut, { capture: true });

  const handleClearWorkflow = () => {
    openOverlay(ConfirmOverlay, {
      title: "Clear Workflow",
      message:
        "Remove every step and connection? The Lifecycle Node is kept, and this saves right away.",
      confirmLabel: "Clear Workflow",
      confirmVariant: "destructive" as const,
      destructive: true,
      onConfirm: () => {
        clearWorkflow();
      },
    });
  };

  const handleDeleteWorkflow = () => {
    openOverlay(ConfirmOverlay, {
      title: "Delete Workflow",
      message: `Are you sure you want to delete "${workflowName}"? This will permanently delete the workflow. This cannot be undone.`,
      confirmLabel: "Delete Workflow",
      confirmVariant: "destructive" as const,
      destructive: true,
      onConfirm: () => {
        if (!currentWorkflowId) {
          return;
        }
        deleteWorkflow.mutate({ workflowId: currentWorkflowId });
      },
    });
  };

  // The switcher dropdown opening is a good moment to re-read the list, and a
  // create or a delete elsewhere invalidates the same key.
  const loadWorkflows = () => refreshWorkflowList(queryClient);

  const duplicateWorkflow = useMutation(
    orpcQuery.workflow.duplicate.mutationOptions({
      onSuccess: async (payload) => {
        toast.success("Workflow duplicated successfully");
        await loadWorkflows();
        await navigate({
          to: "/workflows/$workflowId",
          params: { workflowId: payload.id },
        });
      },
      meta: { errorMessage: "Failed to duplicate workflow. Please try again." },
    })
  );

  const publishWorkflow = useMutation(
    orpcQuery.workflow.publish.mutationOptions({
      onSuccess: (payload) => {
        toast.success(`Published version ${payload.publishedVersion}`);
        cacheWorkflowPublication(queryClient, payload);
        void loadWorkflows();
      },
      // Let Conflict ("Refresh and try again") and validation errors surface
      // their own wording rather than a generic publish failure.
    })
  );

  const handleDuplicate = () => {
    if (!currentWorkflowId) {
      return;
    }
    duplicateWorkflow.mutate({ workflowId: currentWorkflowId });
  };

  const handlePublish = () => {
    if (!currentWorkflowId) {
      return;
    }

    // Says the common half early: required fields and connections, which the
    // canvas has been badging all along. The server stays the authority and
    // asks more than this -- Events, Event Split outlets, template types,
    // unreachable subtrees -- so a graph can still be refused after passing
    // here. A draft saves in any state; this gate does not move, so there is no
    // Publish Anyway.
    const issues = collectWorkflowIssues({
      nodes: toPersistedNodes(nodes),
      catalog,
      integrations: userIntegrations,
    });
    if (hasBlockingWorkflowIssues(issues)) {
      openOverlay(WorkflowIssuesOverlay, {
        issues: groupWorkflowIssuesForOverlay(issues),
        onGoToStep: handleGoToStep,
        allowRunAnyway: false,
      });
      return;
    }

    publishWorkflow.mutate({
      workflowId: currentWorkflowId,
      graph: toSerializedGraph({ nodes, edges }),
    });
  };

  const handleSetWorkflowMode = async (mode: "live" | "test") => {
    if (!currentWorkflowId || workflowMode === mode) {
      return;
    }

    const outcome = await setWorkflowMode(mode);
    if (!outcome?.ok) {
      toast.error("Failed to update workflow mode");
      return;
    }

    // No loadWorkflows: this went through the save queue, which marks the list
    // stale on every write it lands.
    setCurrentWorkflowMode(outcome.workflow.mode);
    toast.success(
      mode === "test"
        ? "Workflow set to Test mode"
        : "Workflow set to Live mode"
    );
  };

  return {
    handleSave,
    handleExecute,
    handleClearWorkflow,
    handleDeleteWorkflow,
    loadWorkflows,
    handleDuplicate,
    isDuplicating: duplicateWorkflow.isPending,
    handlePublish,
    isPublishing: publishWorkflow.isPending,
    handleSetWorkflowMode,
  };
}

export type WorkflowToolbarActions = ReturnType<typeof useWorkflowActions>;
