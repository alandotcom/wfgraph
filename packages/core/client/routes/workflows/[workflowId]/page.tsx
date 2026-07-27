import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { WorkflowSidebarPanel } from "@/components/workflow/workflow-sidebar-panel";
import { useDomEvent } from "@/hooks/effects";
import { repairNodeIntegrations } from "@/lib/node-integration";
import { api } from "@/lib/rpc-client";
import { integrationsQueryOptions } from "@/lib/rpc-query";
import {
  edgesAtom,
  loadWorkflowGraphAtom,
  nodesAtom,
  setNodeStatusesAtom,
} from "@/lib/workflow-graph-store";
import {
  currentWorkflowIdAtom,
  currentWorkflowModeAtom,
  currentWorkflowNameAtom,
  currentWorkflowVisibilityAtom,
  isWorkflowOwnerAtom,
  lastSaveErrorAtom,
  saveWorkflowAtom,
  workflowNotFoundAtom,
} from "@/lib/workflow-save-store";
import {
  isExecutingAtom,
  isGeneratingAtom,
  selectedExecutionIdAtom,
} from "@/lib/workflow-ui-store";
import { type WorkflowNode } from "@/shared/workflow/types";

type WorkflowPageProps = {
  workflowId: string;
};

const WorkflowEditor = ({ workflowId }: WorkflowPageProps) => {
  const queryClient = useQueryClient();
  const isGenerating = useAtomValue(isGeneratingAtom);
  const lastSaveError = useAtomValue(lastSaveErrorAtom);
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const [currentWorkflowId] = useAtom(currentWorkflowIdAtom);
  const [selectedExecutionId] = useAtom(selectedExecutionIdAtom);
  const setIsExecuting = useSetAtom(isExecutingAtom);
  const loadWorkflowGraph = useSetAtom(loadWorkflowGraphAtom);
  const saveWorkflow = useSetAtom(saveWorkflowAtom);
  const setCurrentWorkflowId = useSetAtom(currentWorkflowIdAtom);
  const setCurrentWorkflowName = useSetAtom(currentWorkflowNameAtom);
  const setNodeStatuses = useSetAtom(setNodeStatusesAtom);
  const [workflowNotFound, setWorkflowNotFound] = useAtom(workflowNotFoundAtom);
  const setCurrentWorkflowVisibility = useSetAtom(
    currentWorkflowVisibilityAtom
  );
  const setCurrentWorkflowMode = useSetAtom(currentWorkflowModeAtom);
  const setIsWorkflowOwner = useSetAtom(isWorkflowOwnerAtom);

  // Ref to track polling interval for selected execution
  const selectedExecutionPollingIntervalRef = useRef<NodeJS.Timeout | null>(
    null
  );
  // Ref to ignore stale async loads when user switches workflows quickly.
  const latestWorkflowIdRef = useRef(workflowId);
  // Ref to access current nodes without triggering effect re-runs
  const nodesRef = useRef(nodes);

  // Keep nodes ref in sync
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    latestWorkflowIdRef.current = workflowId;
  }, [workflowId]);

  // Helper function to load existing workflow
  const loadExistingWorkflow = useCallback(async () => {
    try {
      // The connection list is fetched alongside the graph because a stored
      // integrationId can have gone stale since the last save, and repairing it
      // before the graph is ever rendered is what keeps that out of an effect.
      const [workflow, integrations] = await Promise.all([
        api.workflow.getById(workflowId),
        queryClient.ensureQueryData(integrationsQueryOptions()),
      ]);

      if (latestWorkflowIdRef.current !== workflowId) {
        return;
      }

      // Reset node statuses to idle and clear selection when loading from database
      const nodesWithIdleStatus = workflow.nodes.map((node: WorkflowNode) => ({
        ...node,
        selected: false,
        data: {
          ...node.data,
          status: "idle" as const,
        },
      }));

      // Also clears undo history, so undo cannot reach back past the switch and
      // write the previous workflow's graph into this one.
      loadWorkflowGraph({
        nodes: repairNodeIntegrations(nodesWithIdleStatus, integrations),
        edges: workflow.edges,
      });
      setCurrentWorkflowId(workflow.id);
      setCurrentWorkflowName(workflow.name);
      setCurrentWorkflowVisibility(workflow.visibility ?? "private");
      setCurrentWorkflowMode(workflow.mode ?? "live");
      setIsWorkflowOwner(workflow.isOwner !== false); // Default to true if not set
      setWorkflowNotFound(false);
    } catch (error) {
      if (latestWorkflowIdRef.current !== workflowId) {
        return;
      }
      console.error("Failed to load workflow:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to load workflow"
      );
    }
  }, [
    workflowId,
    queryClient,
    loadWorkflowGraph,
    setCurrentWorkflowId,
    setCurrentWorkflowName,
    setCurrentWorkflowVisibility,
    setCurrentWorkflowMode,
    setIsWorkflowOwner,
    setWorkflowNotFound,
  ]);

  useEffect(() => {
    void loadExistingWorkflow();
  }, [loadExistingWorkflow]);

  // A debounced autosave has no caller waiting on it, so a failure would
  // otherwise reach only the console while the editor looked saved.
  useEffect(() => {
    if (lastSaveError) {
      toast.error(lastSaveError.message || "Failed to save workflow");
    }
  }, [lastSaveError]);

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

  // Cleanup polling interval on unmount
  useEffect(
    () => () => {
      if (selectedExecutionPollingIntervalRef.current) {
        clearInterval(selectedExecutionPollingIntervalRef.current);
      }
    },
    []
  );

  // Poll for selected execution status
  useEffect(() => {
    // Clear existing interval if any
    if (selectedExecutionPollingIntervalRef.current) {
      clearInterval(selectedExecutionPollingIntervalRef.current);
      selectedExecutionPollingIntervalRef.current = null;
    }

    // If no execution is selected or it's the currently running one, don't poll
    if (!selectedExecutionId) {
      // Reset all node statuses when no execution is selected
      setNodeStatuses(
        nodesRef.current.map((node) => ({ nodeId: node.id, status: "idle" }))
      );
      setIsExecuting(false);
      return undefined;
    }

    // Start polling for the selected execution
    const pollSelectedExecution = async () => {
      try {
        const statusData =
          await api.workflow.getExecutionStatus(selectedExecutionId);

        setNodeStatuses(
          statusData.nodeStatuses.map((nodeStatus) => ({
            nodeId: nodeStatus.nodeId,
            status:
              nodeStatus.status === "pending" ? "idle" : nodeStatus.status,
          }))
        );

        // Stop polling only for terminal states
        const isRunningLike =
          statusData.status === "running" || statusData.status === "waiting";
        setIsExecuting(isRunningLike);

        if (!isRunningLike && selectedExecutionPollingIntervalRef.current) {
          clearInterval(selectedExecutionPollingIntervalRef.current);
          selectedExecutionPollingIntervalRef.current = null;
        }
      } catch (error) {
        console.error("Failed to poll selected execution status:", error);
        setIsExecuting(false);
        // Clear polling on error
        if (selectedExecutionPollingIntervalRef.current) {
          clearInterval(selectedExecutionPollingIntervalRef.current);
          selectedExecutionPollingIntervalRef.current = null;
        }
      }
    };

    // Poll immediately and then every 500ms
    void pollSelectedExecution();
    const pollInterval = setInterval(pollSelectedExecution, 500);
    selectedExecutionPollingIntervalRef.current = pollInterval;

    return () => {
      if (selectedExecutionPollingIntervalRef.current) {
        clearInterval(selectedExecutionPollingIntervalRef.current);
        selectedExecutionPollingIntervalRef.current = null;
      }
    };
  }, [selectedExecutionId, setIsExecuting, setNodeStatuses]);

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
