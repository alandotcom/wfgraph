/**
 * Toolbar behaviour: pre-run issue collection, execute, and the workflow-level
 * menu actions. Chrome components live beside this file; run animation and
 * payload memory live in `workflow-run-actions`.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useRef } from "react";
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
import {
  PREFLIGHT_BUSY_MESSAGE,
  type WorkflowIssuePreflightResult,
  useWorkflowIssuePreflight,
} from "#src/hooks/use-workflow-issue-preflight";
import { isTextEntry } from "#src/lib/is-text-entry";
import {
  cacheWorkflowPublication,
  integrationsQueryOptions,
  orpcQuery,
  refreshRunHistory,
  refreshWorkflowList,
  refreshWorkflowVersionHistory,
  workflowListQueryOptions,
  workflowPublicationQueryOptions,
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
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  executeWorkflowRun,
  rememberTestPayload,
  type UpdateNodeData,
} from "#src/lib/workflow-run-actions";
import {
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
import { publicationReviewFromComparison } from "#src/components/workflow/publish-review-dialog";
import {
  beginPublicationReviewAtom,
  clearPublicationReviewAtom,
  installPublicationReviewAtom,
  isPublicationReviewActiveAtom,
  isPublicationReviewPendingAtom,
  publicationReviewAtom,
  settlePublicationReviewAtom,
} from "#src/lib/workflow-publication-review-store";
import { isExecutingAtom, isGeneratingAtom } from "#src/lib/workflow-ui-store";
import { enterRunsWorkspaceAtom } from "#src/lib/workflow-workspace-navigation";
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
  groupWorkflowIssuesForOverlay,
  hasBlockingWorkflowIssues,
} from "@wfgraph/shared/graph/workflow-issues";

/** One toast id, so a held Cmd+Enter replaces the notice instead of stacking. */
const PREFLIGHT_TOAST_ID = "workflow-preflight-busy";

type WorkflowHandlerParams = {
  currentWorkflowId: string | null;
  nodes: WorkflowNode[];
  updateNodeData: UpdateNodeData;
  isExecuting: boolean;
  setIsExecuting: (value: boolean) => void;
  setSelectedNodeId: (id: string | null) => void;
  checkWorkflowIssues: (input: {
    workflowId: string;
    nodes: WorkflowNode[];
  }) => Promise<WorkflowIssuePreflightResult>;
};

function useWorkflowHandlers({
  currentWorkflowId,
  nodes,
  updateNodeData,
  isExecuting,
  setIsExecuting,
  setSelectedNodeId,
  checkWorkflowIssues,
}: WorkflowHandlerParams) {
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
  const enterRuns = useSetAtom(enterRunsWorkspaceAtom);
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

  const executeWorkflow = async (request: TestRunRequest) => {
    if (!currentWorkflowId) {
      toast.error("Please save the workflow before executing");
      return;
    }

    // The sample is kept on the entry node, so the next run of this workflow
    // opens on what this one sent. Autosave carries it; the run itself travels
    // on the request and waits for no save.
    rememberTestPayload({ nodes, updateNodeData, request });

    enterRuns();

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
    if (!currentWorkflowId) {
      toast.error("Please save the workflow before executing");
      return;
    }

    const preflight = await checkWorkflowIssues({
      workflowId: currentWorkflowId,
      nodes,
    });
    if (preflight.status !== "ready") {
      // Cmd+Enter reaches this without passing the command palette's disabled
      // state, so a second press during a slow check would otherwise land on
      // nothing at all. `workflow_changed` needs no notice: the operator has
      // already left the workflow the answer was about.
      if (preflight.status === "busy") {
        toast.info(PREFLIGHT_BUSY_MESSAGE, { id: PREFLIGHT_TOAST_ID });
      }
      return;
    }
    const { issues } = preflight;

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
  const workflowName = useAtomValue(currentWorkflowNameAtom);
  const [workflowMode, setCurrentWorkflowMode] = useAtom(
    currentWorkflowModeAtom
  );
  const isOwner = useAtomValue(isWorkflowOwnerAtom);
  const isSaving = useAtomValue(isSavingAtom);
  const hasUnsavedChanges = useAtomValue(hasUnsavedChangesAtom);
  const undo = useSetAtom(undoAtom);
  const redo = useSetAtom(redoAtom);
  const [canUndo] = useAtom(canUndoAtom);
  const [canRedo] = useAtom(canRedoAtom);
  const setSelectedNodeId = useSetAtom(selectedNodeAtom);
  const { data: userIntegrations = [] } = useQuery(integrationsQueryOptions());

  const { data: allWorkflows = [] } = useQuery(workflowListQueryOptions());
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
    isOwner,
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

export type WorkflowToolbarState = ReturnType<typeof useWorkflowState>;

export function useWorkflowActions(state: WorkflowToolbarState) {
  const { open: openOverlay } = useOverlay();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const deleteWorkflow = useDeleteWorkflow();
  const setWorkflowMode = useSetAtom(setWorkflowModeAtom);
  const saveWorkflow = useSetAtom(saveWorkflowAtom);
  const publishReview = useAtomValue(publicationReviewAtom);
  const publicationReviewActive = useAtomValue(isPublicationReviewActiveAtom);
  const publicationReviewPending = useAtomValue(isPublicationReviewPendingAtom);
  const beginPublicationReview = useSetAtom(beginPublicationReviewAtom);
  const installPublicationReview = useSetAtom(installPublicationReviewAtom);
  const clearPublicationReview = useSetAtom(clearPublicationReviewAtom);
  const settlePublicationReview = useSetAtom(settlePublicationReviewAtom);
  const publishingReviewRef = useRef<string | null>(null);
  const {
    currentWorkflowId,
    workflowName,
    workflowMode,
    setCurrentWorkflowMode,
    nodes,
    edges,
    updateNodeData,
    isExecuting,
    isGenerating,
    setIsExecuting,
    clearWorkflow,
    setSelectedNodeId,
    userIntegrations,
    publication,
  } = state;
  const { checkWorkflowIssues, isPreflighting } =
    useWorkflowIssuePreflight(userIntegrations);
  const { handleExecute, handleGoToStep } = useWorkflowHandlers({
    currentWorkflowId,
    nodes,
    updateNodeData,
    isExecuting,
    setIsExecuting,
    setSelectedNodeId,
    checkWorkflowIssues,
  });

  const handleSave = useCallback(async () => {
    if (!currentWorkflowId || isGenerating) {
      return;
    }
    const outcome = await saveWorkflow({ nodes, edges }, { immediate: true });
    if (outcome && !outcome.ok) {
      toast.error(outcome.error.message || "Failed to save workflow");
    }
  }, [currentWorkflowId, edges, isGenerating, nodes, saveWorkflow]);

  // Cmd+S shares the command palette's save path, so an explicit save and the
  // shortcut cannot race the autosave queue differently.
  const handleSaveShortcut = useCallback(
    (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        event.stopPropagation();
        void handleSave();
      }
    },
    [handleSave]
  );

  useDomEvent(document, "keydown", handleSaveShortcut, { capture: true });

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

  // Per-call callbacks run from the click that began this preflight. The hook
  // itself therefore remains a plain RPC declaration during render.
  const publishWorkflow = useMutation(
    orpcQuery.workflow.publish.mutationOptions()
  );
  const compareWorkflowVersion = useMutation(
    orpcQuery.workflow.compareVersion.mutationOptions()
  );

  const handleDuplicate = () => {
    if (!currentWorkflowId) {
      return;
    }
    duplicateWorkflow.mutate({ workflowId: currentWorkflowId });
  };

  const handlePublish = async () => {
    if (!currentWorkflowId || publicationReviewActive) {
      return;
    }

    // Says the common half early: required fields and connections, which the
    // canvas has been badging all along. The server stays the authority and
    // asks more than this -- Events, Event Split outlets, template types,
    // unreachable subtrees -- so a graph can still be refused after passing
    // here. A draft saves in any state; this gate does not move, so there is no
    // Publish Anyway.
    const preflight = await checkWorkflowIssues({
      workflowId: currentWorkflowId,
      nodes,
    });
    if (preflight.status !== "ready") {
      if (preflight.status === "busy") {
        toast.info(PREFLIGHT_BUSY_MESSAGE, { id: PREFLIGHT_TOAST_ID });
      }
      return;
    }
    const { issues } = preflight;
    if (hasBlockingWorkflowIssues(issues)) {
      openOverlay(WorkflowIssuesOverlay, {
        issues: groupWorkflowIssuesForOverlay(issues),
        onGoToStep: handleGoToStep,
        allowRunAnyway: false,
      });
      return;
    }

    const graph = toSerializedGraph({ nodes, edges });
    const input = {
      workflowId: currentWorkflowId,
      ...(publication?.publishedVersionId
        ? { baseVersionId: publication.publishedVersionId }
        : {}),
      draftGraph: graph,
    };
    const epoch = beginPublicationReview(currentWorkflowId);
    if (epoch === null) {
      return;
    }
    compareWorkflowVersion.mutate(input, {
      onSuccess: (comparison, comparisonInput) => {
        if (!comparison.hasChanges) {
          if (
            !clearPublicationReview({
              workflowId: comparisonInput.workflowId,
              epoch,
            })
          ) {
            return;
          }
          cacheWorkflowPublication(queryClient, {
            id: comparisonInput.workflowId,
            hasUnpublishedChanges: false,
          });
          toast.info("No changes to publish");
          return;
        }

        installPublicationReview({
          workflowId: comparisonInput.workflowId,
          epoch,
          pending: false,
          graph: comparisonInput.draftGraph,
          expectedPublishedVersionId: comparison.baseVersion?.id ?? null,
          review: publicationReviewFromComparison(comparison),
        });
      },
      onSettled: (comparison, _error, comparisonInput) => {
        if (!comparison?.hasChanges) {
          clearPublicationReview({
            workflowId: comparisonInput.workflowId,
            epoch,
          });
          return;
        }
        settlePublicationReview({
          workflowId: comparisonInput.workflowId,
          epoch,
        });
      },
    });
  };

  const confirmPublish = () => {
    if (!publishReview || publicationReviewPending) {
      return;
    }
    if (
      publishReview.workflowId !== currentWorkflowId ||
      !publicationReviewActive
    ) {
      clearPublicationReview({
        workflowId: publishReview.workflowId,
        epoch: publishReview.epoch,
      });
      return;
    }
    const publishingKey = `${publishReview.workflowId}:${publishReview.epoch}`;
    if (publishingReviewRef.current === publishingKey) {
      return;
    }

    publishingReviewRef.current = publishingKey;
    publishWorkflow.mutate(
      {
        workflowId: publishReview.workflowId,
        graph: publishReview.graph,
        expectedPublishedVersionId: publishReview.expectedPublishedVersionId,
      },
      {
        onSuccess: (payload) => {
          if (
            clearPublicationReview({
              workflowId: payload.id,
              epoch: publishReview.epoch,
            })
          ) {
            toast.success(`Published version ${payload.publishedVersion}`);
            cacheWorkflowPublication(queryClient, payload);
            void loadWorkflows();
            void refreshWorkflowVersionHistory(queryClient);
          }
        },
        onSettled: (_payload, _error, _publishInput) => {
          if (publishingReviewRef.current === publishingKey) {
            publishingReviewRef.current = null;
          }
        },
      }
    );
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
    confirmPublish,
    isPublishing: publishWorkflow.isPending,
    isComparing: compareWorkflowVersion.isPending,
    isPreflighting,
    publishReview,
    setPublishReviewOpen: (open: boolean) => {
      if (!open) {
        const workflowId =
          publishReview?.workflowId ?? currentWorkflowId ?? undefined;
        if (publishReview) {
          clearPublicationReview({
            workflowId: publishReview.workflowId,
            epoch: publishReview.epoch,
          });
        } else {
          clearPublicationReview(workflowId);
        }
      }
    },
    handleSetWorkflowMode,
  };
}

export type WorkflowToolbarActions = ReturnType<typeof useWorkflowActions>;
