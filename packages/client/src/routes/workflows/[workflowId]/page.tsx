import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import { toast } from "sonner";
import { Button } from "#src/components/ui/button";
import { ExecutionOverlaySync } from "#src/components/workflow/execution-overlay-sync";
import { WorkflowCanvas } from "#src/components/workflow/workflow-canvas";
import { WorkflowSidebarPanel } from "#src/components/workflow/workflow-sidebar-panel";
import { WorkflowStatusStrip } from "#src/components/workflow/workflow-status-strip";
import { WorkflowToolbar } from "#src/components/workflow/workflow-toolbar";
import { useAfterCommit, useDomEvent } from "#src/hooks/effects";
import { isRunInProgress } from "#src/lib/execution-logs";
import { orpcQuery } from "#src/lib/rpc-query";
import {
  edgesAtom,
  isExecutionOverlayActiveAtom,
  nodesAtom,
  setNodeStatusesAtom,
} from "#src/lib/workflow-graph-store";
import {
  currentWorkflowIdAtom,
  lastSaveErrorAtom,
  saveWorkflowAtom,
  workflowNotFoundAtom,
  workflowLoadErrorAtom,
} from "#src/lib/workflow-save-store";
import {
  isExecutingAtom,
  isGeneratingAtom,
  selectedExecutionIdAtom,
} from "#src/lib/workflow-ui-store";

/** How often a run that is still going has its progress read back. */
const RUN_STATUS_POLL_MS = 500;

const WorkflowEditor = () => {
  const isGenerating = useAtomValue(isGeneratingAtom);
  const lastSaveError = useAtomValue(lastSaveErrorAtom);
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const [currentWorkflowId] = useAtom(currentWorkflowIdAtom);
  const [selectedExecutionId] = useAtom(selectedExecutionIdAtom);
  const isExecutionOverlayActive = useAtomValue(isExecutionOverlayActiveAtom);
  const setIsExecuting = useSetAtom(isExecutingAtom);
  const saveWorkflow = useSetAtom(saveWorkflowAtom);
  const setNodeStatuses = useSetAtom(setNodeStatusesAtom);
  const workflowNotFound = useAtomValue(workflowNotFoundAtom);
  const workflowLoadError = useAtomValue(workflowLoadErrorAtom);

  // A debounced autosave has no caller waiting on it, so a failure would
  // otherwise reach only the console while the editor looked saved.
  //
  // Every failure is toasted, including the 400s this used to swallow. Those
  // were half-built nodes the save battery refused, which made the common case
  // of an editor session a silent dropped write; the battery no longer asks, so
  // a 400 here is now something the builder has to be told about.
  useAfterCommit(lastSaveError, () => {
    if (lastSaveError) {
      toast.error(lastSaveError.message || "Failed to save workflow");
    }
  });

  // Keyboard shortcuts
  const handleSave = useCallback(async () => {
    if (!currentWorkflowId || isGenerating) {
      return;
    }
    // Goes through the same queue as autosave, so an in-flight debounced save
    // cannot land afterwards and overwrite what this one just wrote. The queue
    // drives the saving indicator, so there is nothing to bracket here.
    const outcome = await saveWorkflow({ nodes, edges }, { immediate: true });

    if (outcome && !outcome.ok) {
      toast.error(outcome.error.message || "Failed to save workflow");
    }
  }, [currentWorkflowId, nodes, edges, isGenerating, saveWorkflow]);

  // Cmd+S saves. Capture phase, so a focused field in the canvas does not eat
  // it first. Cmd+Enter belongs to the toolbar, which owns the run itself.
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

  // While a run is on screen its progress is read back every half second. The
  // predicate is what stops it: once the run reaches a terminal status there is
  // nothing further to learn, which the hand-managed interval this replaced had
  // to work out for itself in three places, including its error path.
  const executionStatusQuery = useQuery({
    ...orpcQuery.workflow.getExecutionStatus.queryOptions({
      input: { executionId: selectedExecutionId ?? "" },
    }),
    enabled: selectedExecutionId !== null,
    staleTime: 0,
    refetchIntervalInBackground: false,
    refetchInterval: (query) =>
      isRunInProgress(query.state.data?.status) ? RUN_STATUS_POLL_MS : false,
  });

  const executionStatus = executionStatusQuery.data;

  // Projecting a run's progress onto the graph. The statuses live on the nodes
  // because that is where React Flow reads them from, so this is a write into a
  // store rather than something render can return, and the thing it follows is
  // a server response rather than anything the user did. Overlay presence is in
  // the key so a null→present rebuild (late hydrate restore) re-projects chips
  // onto the new nodes; completed runs do not poll, so identity alone is not enough.
  const nodeStatusKey =
    executionStatus?.nodeStatuses
      .map((nodeStatus) => `${nodeStatus.nodeId}=${nodeStatus.status}`)
      .join(",") ?? "";
  useAfterCommit(
    selectedExecutionId === null
      ? "idle"
      : `${selectedExecutionId}:${isExecutionOverlayActive}:${
          executionStatus === undefined
            ? "loading"
            : `${executionStatus.status}:${nodeStatusKey}`
        }`,
    () => {
      if (!selectedExecutionId) {
        setNodeStatuses(
          nodes.map((node) => ({ nodeId: node.id, status: "idle" }))
        );
        setIsExecuting(false);
        return;
      }

      if (!executionStatus) {
        return;
      }

      setNodeStatuses(
        executionStatus.nodeStatuses.map((nodeStatus) => ({
          nodeId: nodeStatus.nodeId,
          status: nodeStatus.status === "pending" ? "idle" : nodeStatus.status,
        }))
      );
      setIsExecuting(isRunInProgress(executionStatus.status));
    }
  );

  return (
    // The editor shell: one row, the canvas column beside the panel column.
    // `relative` because the two failure overlays and the panel's collapsed
    // expand button all measure themselves against the whole editor.
    <div className="relative flex h-dvh w-full overflow-hidden">
      {/* URL → selection + pinned-graph overlay. Sibling of the sidebar so it
          outlives the Runs panel; the status projection above reads what it writes. */}
      <ExecutionOverlaySync />

      {/* Workflow not found overlay */}
      {workflowNotFound && (
        <div className="absolute inset-0 z-20 flex items-center justify-center">
          <div className="rounded-lg border bg-background p-8 text-center shadow-lg">
            <h1 className="mb-2 font-semibold text-2xl">Workflow Not Found</h1>
            <p className="mb-6 text-muted-foreground">
              The workflow you're looking for doesn't exist or has been deleted.
            </p>
            <Button render={<Link to="/" />}>Go to Dashboard</Button>
          </div>
        </div>
      )}

      {workflowLoadError && (
        <div className="absolute inset-0 z-20 flex items-center justify-center">
          <div className="rounded-lg border bg-background p-8 text-center shadow-lg">
            <h1 className="mb-2 font-semibold text-2xl">
              Couldn't Load Workflow
            </h1>
            <p className="mb-6 text-muted-foreground">{workflowLoadError}</p>
            <Button onClick={() => window.location.reload()}>Try Again</Button>
          </div>
        </div>
      )}

      {/* The canvas column: menu bar above, graph in the middle, status strip
          below. All three belong to this column rather than to the shell,
          because the panel beside it runs the full height of the viewport.

          `min-w-0` stops the graph from widening the column past the space the
          panel leaves it. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <WorkflowToolbar workflowId={currentWorkflowId ?? undefined} />
        {/* This box is bounded by the column rather than by the graph inside
            it: React Flow measures whatever height it is given.

            The floor is what stops the two `shrink-0` rows around it from
            eating the canvas, and it yields on a short viewport rather than
            pushing the strip past the shell's clip. At 390px of height, a 20rem
            floor plus the menu bar leaves the strip outside the clip, which
            takes "Back to draft" off screen exactly where the run panel is most
            likely to be collapsed. 40dvh keeps the graph workable on a desktop
            and lets the strip survive on a phone in landscape; the shell clips
            whatever is left over, which is still a far better failure than
            handing React Flow a parent of zero height. */}
        <div className="min-h-[min(20rem,40dvh)] flex-1">
          <WorkflowCanvas />
        </div>
        <WorkflowStatusStrip workflowId={currentWorkflowId ?? undefined} />
      </div>

      <WorkflowSidebarPanel />
    </div>
  );
};

export default WorkflowEditor;
