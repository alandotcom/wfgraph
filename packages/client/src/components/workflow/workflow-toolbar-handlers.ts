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
  RunOverlay,
  type RunRequest,
} from "#src/components/overlays/run-overlay";
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
  refreshWorkflowPublication,
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
import {
  toEditorNode,
  type WorkflowEdge,
  type WorkflowMode,
  type WorkflowNode,
} from "#src/lib/workflow-graph-types";
import {
  executeWorkflowRun,
  rememberTestPayload,
  type UpdateNodeData,
} from "#src/lib/workflow-run-actions";
import {
  runVerbLabel,
  workflowRunTarget,
  type WorkflowRunGraph,
  type WorkflowRunTarget,
} from "#src/lib/workflow-run-labels";
import {
  currentWorkflowIdAtom,
  currentWorkflowModeAtom,
  currentWorkflowNameAtom,
  hasUnsavedChangesAtom,
  isSavingAtom,
  isWorkflowOwnerAtom,
  saveWorkflowAtom,
  setWorkflowModeAtom,
  type SaveOutcome,
  type WorkflowPatch,
} from "#src/lib/workflow-save-store";
import { ApiError, toSerializedGraph } from "#src/lib/rpc-client";
import {
  isPublicationConflictCode,
  PUBLICATION_CONFLICT_CODES,
  type PublicationConflictCode,
} from "@wfgraph/shared/rpc/error-codes";
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
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import type { TestPayloads } from "@wfgraph/shared/lifecycle/test-payloads";

/**
 * Which publication conflict a refused publish is, read off the failure's code.
 *
 * The message beside the code is written for a person and may be reworded, so
 * nothing here looks at it.
 */
function publicationConflictCode(
  error: unknown
): PublicationConflictCode | undefined {
  const code = error instanceof ApiError ? error.code : undefined;
  return isPublicationConflictCode(code) ? code : undefined;
}

/** One toast id, so a held Cmd+Enter replaces the notice instead of stacking. */
const PREFLIGHT_TOAST_ID = "workflow-preflight-busy";

/** `saveWorkflowAtom`'s setter, as the handlers below are handed it. */
type SaveWorkflow = (
  patch: WorkflowPatch,
  options?: { immediate?: boolean }
) => Promise<SaveOutcome | null>;

type WorkflowHandlerParams = {
  currentWorkflowId: string | null;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  updateNodeData: UpdateNodeData;
  isExecuting: boolean;
  setIsExecuting: (value: boolean) => void;
  setSelectedNodeId: (id: string | null) => void;
  checkWorkflowIssues: (input: {
    workflowId: string;
    nodes: WorkflowNode[];
  }) => Promise<WorkflowIssuePreflightResult>;
  workflowMode: WorkflowMode;
  /** The published version's number, absent until the first publish. */
  publishedVersion: number | undefined;
  /** The published version's id, which is the key its graph is read by. */
  publishedVersionId: string | undefined;
  hasUnsavedChanges: boolean;
  saveWorkflow: SaveWorkflow;
};

/**
 * What the run overlay asks of the graph a run will execute: which Events start
 * it, whether it takes an Event-less start, whether it splits on the Event, and
 * the samples that graph kept.
 *
 * The server judges a start against the graph it is about to run, so these come
 * off that same graph. Reading them off the canvas for a published run is how
 * the overlay would offer a Start Event v7 does not accept.
 */
type RunOverlayGraphFacts = {
  startEvents: readonly string[];
  allowManualStart: boolean;
  hasEventSplit: boolean;
  savedPayloads: TestPayloads;
};

function runOverlayGraphFacts(
  nodes: readonly WorkflowNode[]
): RunOverlayGraphFacts {
  const rules = readEntryLifecycleRules(nodes) ?? initialLifecycleRules;
  return {
    startEvents: rules.startEvents,
    allowManualStart: manualStartAllowed(rules),
    hasEventSplit: nodes.some(isEventSplitNode),
    savedPayloads: readEntryTestPayloads(nodes),
  };
}

function useWorkflowHandlers({
  currentWorkflowId,
  nodes,
  edges,
  updateNodeData,
  isExecuting,
  setIsExecuting,
  setSelectedNodeId,
  checkWorkflowIssues,
  workflowMode,
  publishedVersion,
  publishedVersionId,
  hasUnsavedChanges,
  saveWorkflow,
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

  const executeWorkflow = async (
    target: WorkflowRunTarget,
    request: RunRequest
  ) => {
    if (!currentWorkflowId) {
      toast.error("Please save the workflow before executing");
      return;
    }

    // Run draft executes the canvas, and the server reads that canvas out of the
    // workflow row, so a queued edit has to land before the run starts.
    // Autosave is debounced, and a run started inside that window would execute
    // the previous graph while the canvas paints statuses on the one in front of
    // the builder. Run v7 needs none of this: it runs what was published.
    if (target.graph === "draft" && hasUnsavedChanges) {
      const saved = await saveWorkflow({ nodes, edges }, { immediate: true });
      if (saved && !saved.ok) {
        toast.error(saved.error.message || "Failed to save workflow");
        return;
      }
    }

    // The sample is kept on the entry node, so the next Run draft opens on what
    // this one sent. It is written after the flush above, so it rides the next
    // autosave rather than replacing the graph that flush just sent; the run
    // carries its own copy on the request. Only a draft run writes it: the
    // canvas is the graph that press was about, and editing it for a run of a
    // frozen version would dirty a draft the operator never touched.
    if (target.graph === "draft") {
      rememberTestPayload({ nodes, updateNodeData, request });
    }

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
          // Absent means published, on the wire as everywhere else.
          ...(target.graph === "draft" ? { graph: "draft" as const } : {}),
        }),
      nodes,
      setNodeStatuses,
      setIsExecuting,
      runLabel: runVerbLabel(target),
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

  /**
   * The overlay, over the facts of the graph the verb names. The facts arrive
   * as an argument so the two verbs cannot share one source again.
   */
  const openRunOverlay = (
    target: WorkflowRunTarget,
    facts: RunOverlayGraphFacts
  ) => {
    openOverlay(RunOverlay, {
      target,
      ...facts,
      onRun: (request: RunRequest) => {
        void executeWorkflow(target, request);
      },
    });
  };

  /**
   * The published version's own graph, read by version id.
   *
   * A published version is immutable (ADR-0012), so this is fetched once and
   * kept: `fetchQuery` at an infinite stale time answers from the cache on
   * every press after the first.
   */
  const readPublishedGraphFacts = async (
    versionId: string
  ): Promise<RunOverlayGraphFacts | null> => {
    try {
      const payload = await queryClient.fetchQuery({
        ...orpcQuery.workflow.getVersionGraph.queryOptions({
          input: { versionId },
        }),
        staleTime: Number.POSITIVE_INFINITY,
      });
      // The lifecycle facts are the published graph's; the sample payload is
      // the canvas's own. `getVersionGraph` redacts sensitive-looking values,
      // so a sample read off it would send the mask as the run's input.
      return {
        ...runOverlayGraphFacts(
          toWorkflowGraphData(payload.graph).nodes.map(toEditorNode)
        ),
        savedPayloads: readEntryTestPayloads(nodes),
      };
    } catch {
      return null;
    }
  };

  const handleExecute = async (graph: WorkflowRunGraph) => {
    // Guard against concurrent executions
    if (isExecuting) {
      return;
    }
    if (!currentWorkflowId) {
      toast.error("Please save the workflow before executing");
      return;
    }

    const target = workflowRunTarget({
      graph,
      workflowMode,
      publishedVersion,
    });
    if (!target) {
      // A published run of a workflow with nothing published. Every control
      // offering it is disabled with that reason on it, so there is nothing
      // left to say here.
      return;
    }

    // The draft's issues gate the draft's run alone. Publish already refused
    // this graph's blocking issues before it became a version, so a run of the
    // published version is never held back by what the canvas has since broken.
    if (target.graph === "published") {
      if (!publishedVersionId) {
        // A number with no id behind it: there is no graph to read the run's
        // Events off, so there is nothing to open.
        return;
      }
      const facts = await readPublishedGraphFacts(publishedVersionId);
      if (!facts) {
        toast.error(
          `Could not read Published v${target.publishedVersion}. Try again.`
        );
        return;
      }
      openRunOverlay(target, facts);
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
    const draftFacts = runOverlayGraphFacts(nodes);

    if (issues.length > 0) {
      const hasBlocking = hasBlockingWorkflowIssues(issues);
      openOverlay(WorkflowIssuesOverlay, {
        issues: groupWorkflowIssuesForOverlay(issues),
        onGoToStep: handleGoToStep,
        onRunDraftAnyway: hasBlocking
          ? undefined
          : () => openRunOverlay(target, draftFacts),
        allowRunDraftAnyway: !hasBlocking,
      });
      return;
    }

    openRunOverlay(target, draftFacts);
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
    hasUnsavedChanges,
    isOwner,
  } = state;
  const { checkWorkflowIssues, isPreflighting } =
    useWorkflowIssuePreflight(userIntegrations);
  const { handleExecute, handleGoToStep } = useWorkflowHandlers({
    currentWorkflowId,
    nodes,
    edges,
    updateNodeData,
    isExecuting,
    setIsExecuting,
    setSelectedNodeId,
    checkWorkflowIssues,
    workflowMode,
    publishedVersion: publication?.publishedVersion,
    publishedVersionId: publication?.publishedVersionId,
    hasUnsavedChanges,
    saveWorkflow,
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

  // Cmd+Enter is Run draft. The listener lives here, beside handleExecute, so
  // the shortcut and the split button's face are the same call rather than a
  // store round trip for something one function call away. The published
  // version has no chord: it is the deliberate one, and it is reached by
  // naming it.
  //
  // Capture phase, because a focused node in the canvas would otherwise get the
  // keystroke first.
  //
  // A viewer who does not own the workflow gets no run controls at all, and
  // this listener is on the document rather than on one of them, so the owner
  // test that gates the split button is repeated here. Without it the chord
  // would run a graph the viewer cannot edit, and flush the autosave queue on
  // the way.
  const handleRunShortcut = useCallback(
    (event: KeyboardEvent) => {
      if (!((event.metaKey || event.ctrlKey) && event.key === "Enter")) {
        return;
      }
      if (!isOwner || isTextEntry(event.target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void handleExecute("draft");
    },
    [handleExecute, isOwner]
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
    orpcQuery.workflow.publish.mutationOptions({
      // The two coded publication conflicts are answered below in the
      // operator's terms, so the cache's own toast would say it a second time.
      // Only those two are claimed: a per-mutate onError is skipped once the
      // component that called mutate has unmounted, and a generic failure the
      // operator has navigated away from must still reach a toast.
      meta: {
        errorShownByCaller: (error) =>
          publicationConflictCode(error) !== undefined,
      },
    })
  );
  const compareWorkflowVersion = useMutation(
    orpcQuery.workflow.compareVersion.mutationOptions()
  );

  /**
   * Close the publication badge and say the draft is already published.
   *
   * Both the comparison finding no changes and the server refusing the publish
   * for the same reason land here, so the operator reads one sentence either
   * way and the badge stops claiming unpublished changes.
   */
  const reportNothingToPublish = (workflowId: string) => {
    cacheWorkflowPublication(queryClient, {
      id: workflowId,
      hasUnpublishedChanges: false,
    });
    toast.info("No changes to publish");
  };

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
        allowRunDraftAnyway: false,
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
          reportNothingToPublish(comparisonInput.workflowId);
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
        onError: (error) => {
          const conflict = publicationConflictCode(error);
          if (!conflict) {
            // Anything else keeps what a failed write has always done: the
            // mutation cache says what the server said, and the review stays
            // open to try again.
            return;
          }

          // Both coded conflicts end the review this attempt was built on. The
          // epoch is what stops a late answer from closing a review the
          // operator has opened since, exactly as the success path is held.
          if (
            !clearPublicationReview({
              workflowId: publishReview.workflowId,
              epoch: publishReview.epoch,
            })
          ) {
            return;
          }

          if (conflict === PUBLICATION_CONFLICT_CODES.stale) {
            // The version this draft was compared against is no longer the
            // current one, so the changes the operator approved no longer
            // describe what publishing would do. Read the publication state
            // back and leave them to review again; the canvas keeps the draft
            // it has.
            void refreshWorkflowPublication(
              queryClient,
              publishReview.workflowId
            );
            void refreshWorkflowVersionHistory(queryClient);
            toast.error(
              "Someone published a newer version while you were reviewing. Publish again to compare against it."
            );
            return;
          }

          reportNothingToPublish(publishReview.workflowId);
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
        ? "Published mode set to Test"
        : "Published mode set to Live"
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
