import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { WorkflowSidebarPanel } from "@/components/workflow/workflow-sidebar-panel";
import { useAfterCommit, useDomEvent } from "@/hooks/effects";
import { isRunInProgress } from "@/lib/execution-logs";
import { orpcQuery } from "@/lib/rpc-query";
import {
  edgesAtom,
  nodesAtom,
  setNodeStatusesAtom,
} from "@/lib/workflow-graph-store";
import {
  currentWorkflowIdAtom,
  lastSaveErrorAtom,
  saveWorkflowAtom,
  workflowNotFoundAtom,
} from "@/lib/workflow-save-store";
import {
  isExecutingAtom,
  isGeneratingAtom,
  selectedExecutionIdAtom,
} from "@/lib/workflow-ui-store";

/** How often a run that is still going has its progress read back. */
const RUN_STATUS_POLL_MS = 500;

const WorkflowEditor = () => {
  const isGenerating = useAtomValue(isGeneratingAtom);
  const lastSaveError = useAtomValue(lastSaveErrorAtom);
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const [currentWorkflowId] = useAtom(currentWorkflowIdAtom);
  const [selectedExecutionId] = useAtom(selectedExecutionIdAtom);
  const setIsExecuting = useSetAtom(isExecutingAtom);
  const saveWorkflow = useSetAtom(saveWorkflowAtom);
  const setNodeStatuses = useSetAtom(setNodeStatusesAtom);
  const workflowNotFound = useAtomValue(workflowNotFoundAtom);

  // A debounced autosave has no caller waiting on it, so a failure would
  // otherwise reach only the console while the editor looked saved.
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
  // a server response rather than anything the user did.
  useAfterCommit(executionStatus ?? selectedExecutionId, () => {
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
  });

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden">
      {/* Workflow not found overlay */}
      {workflowNotFound && (
        <div className="pointer-events-auto absolute inset-0 z-20 flex items-center justify-center">
          <div className="rounded-lg border bg-background p-8 text-center shadow-lg">
            <h1 className="mb-2 font-semibold text-2xl">Workflow Not Found</h1>
            <p className="mb-6 text-muted-foreground">
              The workflow you're looking for doesn't exist or has been deleted.
            </p>
            <Button render={<Link to="/" />}>Go to Dashboard</Button>
          </div>
        </div>
      )}

      <WorkflowSidebarPanel />
    </div>
  );
};

export default WorkflowEditor;
