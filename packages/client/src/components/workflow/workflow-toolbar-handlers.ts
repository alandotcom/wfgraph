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
import { useDomEvent } from "#src/hooks/effects";
import { getExtensionCatalog } from "#src/lib/extensions";
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
  updateNodeDataAtom,
  addNodeAtom,
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
  workflowNameErrorAtom,
} from "#src/lib/workflow-save-store";
import { toSerializedGraph } from "#src/lib/rpc-client";
import {
  isExecutingAtom,
  isGeneratingAtom,
  isTransitioningFromHomepageAtom,
  propertiesPanelActiveTabAtom,
  selectedExecutionIdAtom,
} from "#src/lib/workflow-ui-store";
import {
  readEntryLifecycleRules,
  readEntryTestPayloads,
} from "#src/lib/test-payload";
import { isEventSplitNode } from "@rova/shared/lifecycle/event-split";
import {
  initialLifecycleRules,
  manualStartAllowed,
} from "@rova/shared/lifecycle/lifecycle-rules";
import {
  collectWorkflowIssues,
  groupWorkflowIssuesForOverlay,
  hasBlockingWorkflowIssues,
} from "@rova/shared/graph/workflow-issues";

type WorkflowHandlerParams = {
  currentWorkflowId: string | null;
  workflowName: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  updateNodeData: UpdateNodeData;
  isExecuting: boolean;
  setIsExecuting: (value: boolean) => void;
  setCurrentWorkflowName: (name: string) => void;
  setWorkflowNameError: (message: string | null) => void;
  setIsTransitioningFromHomepage: (value: boolean) => void;
  setActiveTab: (value: string) => void;
  setSelectedNodeId: (id: string | null) => void;
  setSelectedExecutionId: (id: string | null) => void;
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
  setWorkflowNameError,
  setIsTransitioningFromHomepage,
  setActiveTab,
  setSelectedNodeId,
  setSelectedExecutionId,
  userIntegrations,
}: WorkflowHandlerParams) {
  const { open: openOverlay } = useOverlay();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const clearGraphSelection = useSetAtom(clearGraphSelectionAtom);
  const setExecutionOverlay = useSetAtom(executionOverlayGraphAtom);
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

  const handleSave = async () => {
    // The `add` node is a placeholder, so a canvas holding only one has nothing
    // worth saving. The save itself strips it; this is the emptiness check.
    if (!nodes.some((node) => node.type !== "add")) {
      setWorkflowNameError("Add at least one step before saving.");
      return;
    }

    const trimmedWorkflowName = workflowName.trim();
    if (!trimmedWorkflowName) {
      setWorkflowNameError("Workflow name is required.");
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
        setWorkflowNameError(
          outcome.error.message || "Failed to save workflow. Please try again."
        );
        return;
      }

      setCurrentWorkflowName(trimmedWorkflowName);
      setWorkflowNameError(null);
      return;
    }

    // Creating adopts the new workflow's identity inside the save store.
    const outcome = await createWorkflow({
      name: trimmedWorkflowName,
      nodes,
      edges,
    });

    if (!outcome.ok) {
      setWorkflowNameError(
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
      updateNodeData,
      setIsExecuting,
      setSelectedExecutionId,
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

  const handleGoToStep = (nodeId: string, fieldKey?: string) => {
    setSelectedNodeId(nodeId);
    setActiveTab("properties");

    // Focus on the specific field after a short delay to allow the panel to render
    if (fieldKey) {
      setTimeout(() => {
        const element = document.getElementById(fieldKey);
        if (element) {
          element.focus();
          element.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 100);
    }
  };

  const handleExecute = async () => {
    // Guard against concurrent executions
    if (isExecuting) {
      return;
    }

    const issues = collectWorkflowIssues({
      nodes,
      catalog: getExtensionCatalog(),
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
  const setWorkflowNameError = useSetAtom(workflowNameErrorAtom);
  const setIsTransitioningFromHomepage = useSetAtom(
    isTransitioningFromHomepageAtom
  );
  const isOwner = useAtomValue(isWorkflowOwnerAtom);
  const isSaving = useAtomValue(isSavingAtom);
  const hasUnsavedChanges = useAtomValue(hasUnsavedChangesAtom);
  const undo = useSetAtom(undoAtom);
  const redo = useSetAtom(redoAtom);
  const addNode = useSetAtom(addNodeAtom);
  const [canUndo] = useAtom(canUndoAtom);
  const [canRedo] = useAtom(canRedoAtom);
  const setActiveTab = useSetAtom(propertiesPanelActiveTabAtom);
  const setSelectedNodeId = useSetAtom(selectedNodeAtom);
  const setSelectedExecutionId = useSetAtom(selectedExecutionIdAtom);
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
    setWorkflowNameError,
    setIsTransitioningFromHomepage,
    isOwner,
    isSaving,
    hasUnsavedChanges,
    undo,
    redo,
    addNode,
    canUndo,
    canRedo,
    allWorkflows,
    setActiveTab,
    setSelectedNodeId,
    setSelectedExecutionId,
    userIntegrations,
  };
}

/** Typing somewhere should not be interrupted by a workflow-level shortcut. */
function isTextEntry(target: HTMLElement): boolean {
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
}

export type WorkflowToolbarState = ReturnType<typeof useWorkflowState>;

export function useWorkflowActions(state: WorkflowToolbarState) {
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
    setWorkflowNameError,
    setIsTransitioningFromHomepage,
    nodes,
    edges,
    updateNodeData,
    isExecuting,
    setIsExecuting,
    clearWorkflow,
    setActiveTab,
    setSelectedNodeId,
    setSelectedExecutionId,
    userIntegrations,
  } = state;

  const { handleSave, handleExecute } = useWorkflowHandlers({
    currentWorkflowId,
    workflowName,
    nodes,
    edges,
    updateNodeData,
    isExecuting,
    setIsExecuting,
    setCurrentWorkflowName,
    setWorkflowNameError,
    setIsTransitioningFromHomepage,
    setActiveTab,
    setSelectedNodeId,
    setSelectedExecutionId,
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
      const target = event.target;
      if (target instanceof HTMLElement && isTextEntry(target)) {
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
      meta: { errorMessage: "Failed to publish workflow. Please try again." },
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
