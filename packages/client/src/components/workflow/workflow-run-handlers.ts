/**
 * The toolbar's run pipeline: the pre-run issue check, the run overlay, the
 * execute call, and the re-read a stale refusal forces. The save, publish and
 * duplicate handlers live in `workflow-toolbar-handlers`.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useSetAtom } from "jotai";
import { toast } from "sonner";
import {
  RunOverlay,
  type RunRequest,
} from "#src/components/overlays/run-overlay";
import { WorkflowIssuesOverlay } from "#src/components/overlays/workflow-issues-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { useGoToStep } from "#src/hooks/use-workflow-issues";
import {
  PREFLIGHT_BUSY_MESSAGE,
  type WorkflowIssuePreflightResult,
} from "#src/hooks/use-workflow-issue-preflight";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  orpcQuery,
  refreshRunHistory,
  refreshWorkflowPublication,
} from "#src/lib/rpc-query";
import {
  clearGraphSelectionAtom,
  executionOverlayGraphAtom,
  setNodeStatusesAtom,
} from "#src/lib/workflow-graph-store";
import {
  toEditorEdge,
  toEditorNode,
  type WorkflowEdge,
  type WorkflowNode,
} from "#src/lib/workflow-graph-types";
import {
  executeWorkflowRun,
  rememberTestPayload,
} from "#src/lib/workflow-run-actions";
import {
  type RunSends,
  runSends,
  runCommandLabel,
  workflowRunTarget,
  type WorkflowRunGraph,
  type WorkflowRunTarget,
} from "#src/lib/workflow-run-labels";
import {
  currentWorkflowModeAtom,
  type SaveOutcome,
  type WorkflowPatch,
} from "#src/lib/workflow-save-store";
import { ApiError } from "#src/lib/rpc-client";
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
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import type { TestPayloads } from "@wfgraph/shared/lifecycle/test-payloads";
import type { WorkflowToolbarState } from "#src/components/workflow/workflow-toolbar-state";

/** The status an oRPC conflict arrives as, which `ApiError` carries. */
const CONFLICT_STATUS = 409;

/**
 * Whether a refused run is the one the staleness gate turned away.
 *
 * A published run repeats the version id and the Published mode the run dialog
 * displayed, and the server refuses it with a conflict when either has moved
 * since. A run that sent no `expected` cannot be refused that way, and the
 * staleness gate is the only conflict `workflow.execute` answers with, so the
 * pair identifies it without reading the message.
 */
function isStalePublishedRun(
  error: unknown,
  variables: { expected?: unknown }
): boolean {
  return (
    variables.expected !== undefined &&
    error instanceof ApiError &&
    error.status === CONFLICT_STATUS
  );
}

/** One toast id, so a held Cmd+Enter replaces the notice instead of stacking. */
export const PREFLIGHT_TOAST_ID = "workflow-preflight-busy";

/** `saveWorkflowAtom`'s setter, as the handlers below are handed it. */
type SaveWorkflow = (
  patch: WorkflowPatch,
  options?: { immediate?: boolean }
) => Promise<SaveOutcome | null>;

export type WorkflowHandlerInput = {
  state: WorkflowToolbarState;
  checkWorkflowIssues: (input: {
    workflowId: string;
    nodes: WorkflowNode[];
  }) => Promise<WorkflowIssuePreflightResult>;
  saveWorkflow: SaveWorkflow;
};

/**
 * The facts the run overlay needs about the graph a run executes: which Events
 * start it, whether it accepts an Event-less start, whether it splits on the
 * Event, the samples it kept, and what it can send outward.
 *
 * The server validates a start against the graph it is about to run, so read
 * these from that same graph. Reading them from the canvas for a published run
 * would offer a Start Event that the published version rejects.
 */
type RunOverlayGraphFacts = {
  startEvents: readonly string[];
  allowManualStart: boolean;
  hasEventSplit: boolean;
  savedPayloads: TestPayloads;
  sends: RunSends;
};

/**
 * The edges are needed only to count the sends. A step sends outward only when
 * the run can reach it, and reachability is computed from the edges.
 */
function runOverlayGraphFacts(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  catalog: ExtensionCatalog
): RunOverlayGraphFacts {
  const rules = readEntryLifecycleRules(nodes) ?? initialLifecycleRules;
  return {
    startEvents: rules.startEvents,
    allowManualStart: manualStartAllowed(rules),
    hasEventSplit: nodes.some(isEventSplitNode),
    savedPayloads: readEntryTestPayloads(nodes),
    sends: runSends({ nodes, edges, catalog }),
  };
}

export function useWorkflowHandlers({
  state,
  checkWorkflowIssues,
  saveWorkflow,
}: WorkflowHandlerInput) {
  const {
    canExecute,
    canReadVersionGraph,
    canUpdate,
    currentWorkflowId,
    edges,
    hasUnsavedChanges,
    isExecuting,
    nodes,
    publication,
    setIsExecuting,
    setSelectedNodeId,
    updateNodeData,
    workflowMode,
  } = state;
  // The published version's number, absent until the first publish, and its id,
  // which is the key its graph is read by.
  const publishedVersion = publication?.publishedVersion;
  const publishedVersionId = publication?.publishedVersionId;
  // The same implementation the status strip's issue count reaches for, so
  // "Fix" means one thing wherever the list was opened from. The hook is
  // instantiated per caller and each instance owns its own pending-focus state;
  // that state is write-then-consume within a single click, so only the
  // instance whose overlay was clicked ever holds one.
  const handleGoToStep = useGoToStep();
  // Used only to name the integrations a live published run sends through,
  // which the run overlay states before it confirms.
  const catalog = useExtensionCatalog();
  const { open: openOverlay } = useOverlay();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const clearGraphSelection = useSetAtom(clearGraphSelectionAtom);
  const setExecutionOverlay = useSetAtom(executionOverlayGraphAtom);
  const setNodeStatuses = useSetAtom(setNodeStatusesAtom);
  const enterRuns = useSetAtom(enterRunsWorkspaceAtom);
  const setCurrentWorkflowMode = useSetAtom(currentWorkflowModeAtom);

  /**
   * Re-read the workflow after the server refused a run as stale.
   *
   * The toolbar builds `expected` from the publication badge's cache entry and
   * from `currentWorkflowModeAtom`, so both have to move before the next press
   * sends anything different. Invalidating the entry repaints the badge, and
   * the read that follows returns what that refetch produced, or fetches once
   * itself when nothing was observing the entry.
   */
  const rereadPublishedState = async (workflowId: string) => {
    await refreshWorkflowPublication(queryClient, workflowId);
    const workflow = await queryClient.fetchQuery(
      orpcQuery.workflow.getById.queryOptions({ input: { workflowId } })
    );
    setCurrentWorkflowMode(workflow.mode);
  };

  // No errorMessage: a rejected run carries a server message worth reading, and
  // the mutation cache falls back to it. Every other outcome arrives as a
  // successful response with a status on it, which executeWorkflowRun reads.
  const runWorkflow = useMutation(
    orpcQuery.workflow.execute.mutationOptions({
      // A started run belongs in both run lists, and the dashboard's is the one
      // nobody is looking at when this fires.
      onSuccess: () => refreshRunHistory(queryClient),
      // A stale refusal leaves the toolbar holding the version and the mode
      // that produced it, so pressing Run again would send the same request
      // and be refused the same way. Read the workflow back so the next press
      // offers what is published now. A read that fails leaves the toast the
      // mutation cache is about to show, and the next page load seeds the
      // state from the route loader.
      onError: (error, variables) => {
        if (isStalePublishedRun(error, variables)) {
          void rereadPublishedState(variables.workflowId).catch(
            () => undefined
          );
        }
      },
    })
  );

  const executeWorkflow = async (
    target: WorkflowRunTarget,
    request: RunRequest
  ) => {
    if (!canExecute || (target.graph === "draft" && !canUpdate)) {
      return;
    }
    if (!currentWorkflowId) {
      toast.error("Please save the workflow before executing");
      return;
    }

    // Run draft executes the canvas, and the server reads that canvas from the
    // workflow row, so a queued edit must land before the run starts. Autosave
    // is debounced, so a run started inside that window would execute the
    // previous graph while the canvas paints statuses on the current one. A
    // published run skips this, because it runs the published version.
    if (target.graph === "draft" && hasUnsavedChanges) {
      const saved = await saveWorkflow({ nodes, edges }, { immediate: true });
      if (saved && !saved.ok) {
        toast.error(saved.error.message || "Failed to save workflow");
        return;
      }
    }

    // Store the sample on the entry node so the next Run draft opens on what
    // this run sent. The write happens after the flush above, so it rides the
    // next autosave instead of replacing the graph the flush just sent. The run
    // request carries its own copy of the sample. Only a draft run writes it,
    // because writing it for a published run would dirty an untouched draft.
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
        runWorkflow.mutateAsync(
          omitUndefined({
            workflowId: currentWorkflowId,
            input: request.input,
            eventName: request.eventName,
            // An absent field means the published graph, on the wire and in the UI.
            graph: target.graph === "draft" ? ("draft" as const) : undefined,
            // What the run dialog displayed. The server refuses the run when the
            // published version or the Published mode has moved since, so a
            // dialog left open across a publish or a mode change cannot start a
            // run for a graph or a set of recipients nobody saw.
            expected:
              target.graph === "published" && publishedVersionId
                ? { versionId: publishedVersionId, mode: target.workflowMode }
                : undefined,
          })
        ),
      nodes,
      setNodeStatuses,
      setIsExecuting,
      runLabel: runCommandLabel(target),
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
   * Opens the overlay over the facts of the graph the command names. The facts
   * are passed in, so the two run commands cannot read the same graph twice.
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
      // Take the lifecycle facts from the published graph and the sample
      // payload from the canvas. `getVersionGraph` redacts sensitive-looking
      // values, so a sample read from it would send the mask as the run input.
      const published = toWorkflowGraphData(payload.graph);
      return {
        ...runOverlayGraphFacts(
          published.nodes.map(toEditorNode),
          published.edges.map(toEditorEdge),
          catalog
        ),
        savedPayloads: readEntryTestPayloads(nodes),
      };
    } catch {
      return null;
    }
  };

  const handleExecute = async (graph: WorkflowRunGraph) => {
    if (!canExecute || (graph === "draft" && !canUpdate)) {
      return;
    }
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
      // that offers it is already disabled with that reason, so do nothing.
      return;
    }

    // The draft's issues gate the draft run only. Publish rejects blocking
    // issues before a graph becomes a version, so a published run is not held
    // back by problems introduced on the canvas since.
    if (target.graph === "published") {
      if (!(canReadVersionGraph && publishedVersionId)) {
        // A version number with no id. There is no graph to read the run's
        // Events from, so there is nothing to open.
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
    const draftFacts = runOverlayGraphFacts(nodes, edges, catalog);

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
