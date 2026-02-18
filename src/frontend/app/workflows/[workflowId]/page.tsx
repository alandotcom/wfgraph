import { Link } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  integrationsAtom,
  integrationsLoadedAtom,
  integrationsVersionAtom,
} from "@/client/lib/integrations-store";
import { api } from "@/client/lib/rpc-client";
import {
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  currentWorkflowVisibilityAtom,
  edgesAtom,
  hasUnsavedChangesAtom,
  isExecutingAtom,
  isGeneratingAtom,
  isSavingAtom,
  isWorkflowOwnerAtom,
  nodesAtom,
  selectedExecutionIdAtom,
  setNodeStatusesAtom,
  triggerExecuteAtom,
  updateNodeDataAtom,
  type WorkflowNode,
  type WorkflowVisibility,
  workflowNotFoundAtom,
} from "@/client/lib/workflow-store";
import { Button } from "@/components/ui/button";
import { WorkflowSidebarPanel } from "@/components/workflow/workflow-sidebar-panel";
import { findActionById } from "@/plugins";
import {
  type IntegrationType,
  isIntegrationType,
} from "@/shared/types/integration";
import { SYSTEM_ACTION_INTEGRATIONS } from "@/shared/workflow/system-action-integrations";

type WorkflowPageProps = {
  workflowId: string;
};

function readConfigString(
  config: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = config?.[key];
  return typeof value === "string" ? value : undefined;
}

// Helper to get required integration type for an action
function getRequiredIntegrationType(
  actionType: string
): IntegrationType | undefined {
  const action = findActionById(actionType);
  const actionIntegrationType = isIntegrationType(action?.integration)
    ? action.integration
    : undefined;
  return actionIntegrationType || SYSTEM_ACTION_INTEGRATIONS[actionType];
}

// Helper to check and fix a single node's integration
type IntegrationFixResult = {
  nodeId: string;
  newIntegrationId: string | undefined;
};

function checkNodeIntegration(
  node: WorkflowNode,
  allIntegrations: { id: string; type: string }[],
  validIntegrationIds: Set<string>
): IntegrationFixResult | null {
  const actionType = readConfigString(node.data.config, "actionType");
  if (!actionType) {
    return null;
  }

  const integrationType = getRequiredIntegrationType(actionType);
  if (!integrationType) {
    return null;
  }

  const currentIntegrationId = readConfigString(
    node.data.config,
    "integrationId"
  );
  const hasValidIntegration =
    currentIntegrationId && validIntegrationIds.has(currentIntegrationId);

  if (hasValidIntegration) {
    return null;
  }

  // Find available integrations of this type
  const available = allIntegrations.filter((i) => i.type === integrationType);

  if (available.length === 1) {
    return { nodeId: node.id, newIntegrationId: available[0].id };
  }
  if (available.length === 0 && currentIntegrationId) {
    return { nodeId: node.id, newIntegrationId: undefined };
  }
  return null;
}

const WorkflowEditor = ({ workflowId }: WorkflowPageProps) => {
  const isGenerating = useAtomValue(isGeneratingAtom);
  const [_isSaving, setIsSaving] = useAtom(isSavingAtom);
  const [nodes] = useAtom(nodesAtom);
  const [edges] = useAtom(edgesAtom);
  const [currentWorkflowId] = useAtom(currentWorkflowIdAtom);
  const [selectedExecutionId] = useAtom(selectedExecutionIdAtom);
  const setIsExecuting = useSetAtom(isExecutingAtom);
  const setNodes = useSetAtom(nodesAtom);
  const setEdges = useSetAtom(edgesAtom);
  const setCurrentWorkflowId = useSetAtom(currentWorkflowIdAtom);
  const setCurrentWorkflowName = useSetAtom(currentWorkflowNameAtom);
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const setNodeStatuses = useSetAtom(setNodeStatusesAtom);
  const setHasUnsavedChanges = useSetAtom(hasUnsavedChangesAtom);
  const [workflowNotFound, setWorkflowNotFound] = useAtom(workflowNotFoundAtom);
  const setTriggerExecute = useSetAtom(triggerExecuteAtom);
  const setCurrentWorkflowVisibility = useSetAtom(
    currentWorkflowVisibilityAtom
  );
  const [isOwner, setIsWorkflowOwner] = useAtom(isWorkflowOwnerAtom);
  const setGlobalIntegrations = useSetAtom(integrationsAtom);
  const setIntegrationsLoaded = useSetAtom(integrationsLoadedAtom);
  const integrationsVersion = useAtomValue(integrationsVersionAtom);

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
      const workflow = await api.workflow.getById(workflowId);

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

      setNodes(nodesWithIdleStatus);
      setEdges(workflow.edges);
      setCurrentWorkflowId(workflow.id);
      setCurrentWorkflowName(workflow.name);
      setCurrentWorkflowVisibility(
        (workflow.visibility as WorkflowVisibility) ?? "private"
      );
      setIsWorkflowOwner(workflow.isOwner !== false); // Default to true if not set
      setHasUnsavedChanges(false);
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
    setNodes,
    setEdges,
    setCurrentWorkflowId,
    setCurrentWorkflowName,
    setCurrentWorkflowVisibility,
    setIsWorkflowOwner,
    setHasUnsavedChanges,
    setWorkflowNotFound,
  ]);

  // Track if we've already auto-fixed integrations for this workflow+version
  const lastAutoFixRef = useRef<{ workflowId: string; version: number } | null>(
    null
  );

  useEffect(() => {
    loadExistingWorkflow();
  }, [loadExistingWorkflow]);

  // Auto-fix invalid/missing integrations on workflow load or when integrations change
  useEffect(() => {
    // Skip if no nodes or no workflow
    if (nodes.length === 0 || !currentWorkflowId) {
      return;
    }

    // Skip for non-owners (they can't modify the workflow and may not be authenticated)
    if (!isOwner) {
      return;
    }

    // Skip if already checked for this workflow+version combination
    const lastFix = lastAutoFixRef.current;
    if (
      lastFix &&
      lastFix.workflowId === currentWorkflowId &&
      lastFix.version === integrationsVersion
    ) {
      return;
    }

    const autoFixIntegrations = async () => {
      try {
        const allIntegrations = await api.integration.getAll({});
        setGlobalIntegrations(allIntegrations);
        setIntegrationsLoaded(true);

        const validIds = new Set(allIntegrations.map((i) => i.id));
        const fixes = nodes
          .map((node) => checkNodeIntegration(node, allIntegrations, validIds))
          .filter((fix): fix is IntegrationFixResult => fix !== null);

        for (const fix of fixes) {
          const node = nodes.find((n) => n.id === fix.nodeId);
          if (node) {
            updateNodeData({
              id: fix.nodeId,
              data: {
                config: {
                  ...node.data.config,
                  integrationId: fix.newIntegrationId,
                },
              },
            });
          }
        }

        lastAutoFixRef.current = {
          workflowId: currentWorkflowId,
          version: integrationsVersion,
        };
        if (fixes.length > 0) {
          setHasUnsavedChanges(true);
        }
      } catch (error) {
        console.error("Failed to auto-fix integrations:", error);
      }
    };

    autoFixIntegrations();
  }, [
    nodes,
    currentWorkflowId,
    integrationsVersion,
    isOwner,
    updateNodeData,
    setGlobalIntegrations,
    setIntegrationsLoaded,
    setHasUnsavedChanges,
  ]);

  // Keyboard shortcuts
  const handleSave = useCallback(async () => {
    if (!currentWorkflowId || isGenerating) {
      return;
    }
    setIsSaving(true);
    try {
      await api.workflow.update(currentWorkflowId, { nodes, edges });
      setHasUnsavedChanges(false);
    } catch (error) {
      console.error("Failed to save workflow:", error);
      toast.error("Failed to save workflow");
    } finally {
      setIsSaving(false);
    }
  }, [
    currentWorkflowId,
    nodes,
    edges,
    isGenerating,
    setIsSaving,
    setHasUnsavedChanges,
  ]);

  // Helper to check if target is an input element
  const isInputElement = useCallback(
    (target: HTMLElement) =>
      target.tagName === "INPUT" || target.tagName === "TEXTAREA",
    []
  );

  // Helper to handle save shortcut
  const handleSaveShortcut = useCallback(
    (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        e.stopPropagation();
        handleSave();
        return true;
      }
      return false;
    },
    [handleSave]
  );

  // Helper to handle run shortcut
  // Uses triggerExecuteAtom to share the same execute flow as the Run button
  // This ensures keyboard shortcut goes through the same checks (e.g., missing integrations)
  const handleRunShortcut = useCallback(
    (e: KeyboardEvent, target: HTMLElement) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        if (!isInputElement(target)) {
          e.preventDefault();
          e.stopPropagation();
          // Trigger execute via atom - the toolbar will handle it
          setTriggerExecute(true);
        }
        return true;
      }
      return false;
    },
    [setTriggerExecute, isInputElement]
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      // Handle save shortcut
      if (handleSaveShortcut(e)) {
        return;
      }

      // Handle run shortcut
      if (handleRunShortcut(e, target)) {
        return;
      }
    };

    // Use capture phase only to ensure we can intercept before other handlers
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [handleSaveShortcut, handleRunShortcut]);

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
      return;
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
    pollSelectedExecution();
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

      <WorkflowSidebarPanel enableEntryAnimation />
    </div>
  );
};

export default WorkflowEditor;
