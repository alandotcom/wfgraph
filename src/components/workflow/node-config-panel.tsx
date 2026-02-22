import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { Eraser, Eye, EyeOff, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { integrationsAtom } from "@/client/lib/integrations-store";
import { ApiError, api } from "@/client/lib/rpc-client";
import {
  clearNodeStatusesAtom,
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  deleteEdgeAtom,
  deleteNodeAtom,
  deleteSelectedItemsAtom,
  edgesAtom,
  isGeneratingAtom,
  isWorkflowOwnerAtom,
  newlyCreatedNodeIdAtom,
  nodesAtom,
  pendingIntegrationNodesAtom,
  propertiesPanelActiveTabAtom,
  selectedEdgeAtom,
  selectedNodeAtom,
  showClearDialogAtom,
  showDeleteDialogAtom,
  updateNodeDataAtom,
  workflowNameErrorAtom,
} from "@/client/lib/workflow-store";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { findActionById } from "@/plugins";
import {
  type IntegrationType,
  isIntegrationType,
} from "@/shared/types/integration";
import { SYSTEM_ACTION_INTEGRATIONS } from "@/shared/workflow/system-action-integrations";
import { ActionConfig } from "./config/action-config";
import { ActionGrid } from "./config/action-grid";
import { TriggerConfig } from "./config/trigger-config";
import { WorkflowRuns } from "./workflow-runs";

function getConfigString(
  config: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = config?.[key];
  return typeof value === "string" ? value : undefined;
}

function getActionIntegrationType(
  actionType: string
): IntegrationType | undefined {
  const action = findActionById(actionType);
  if (isIntegrationType(action?.integration)) {
    return action.integration;
  }

  return SYSTEM_ACTION_INTEGRATIONS[actionType];
}

export const PanelInner = () => {
  const store = useStore();
  const [selectedNodeId] = useAtom(selectedNodeAtom);
  const [selectedEdgeId] = useAtom(selectedEdgeAtom);
  const [nodes] = useAtom(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const [isGenerating] = useAtom(isGeneratingAtom);
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const [currentWorkflowName, setCurrentWorkflowName] = useAtom(
    currentWorkflowNameAtom
  );
  const [workflowNameError, setWorkflowNameError] = useAtom(
    workflowNameErrorAtom
  );
  const isOwner = useAtomValue(isWorkflowOwnerAtom);
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const deleteNode = useSetAtom(deleteNodeAtom);
  const deleteEdge = useSetAtom(deleteEdgeAtom);
  const deleteSelectedItems = useSetAtom(deleteSelectedItemsAtom);
  const setShowClearDialog = useSetAtom(showClearDialogAtom);
  const setShowDeleteDialog = useSetAtom(showDeleteDialogAtom);
  const clearNodeStatuses = useSetAtom(clearNodeStatusesAtom);
  const setPendingIntegrationNodes = useSetAtom(pendingIntegrationNodesAtom);
  const [newlyCreatedNodeId, setNewlyCreatedNodeId] = useAtom(
    newlyCreatedNodeIdAtom
  );
  const [showDeleteNodeAlert, setShowDeleteNodeAlert] = useState(false);
  const [showDeleteEdgeAlert, setShowDeleteEdgeAlert] = useState(false);
  const [showDeleteRunsAlert, setShowDeleteRunsAlert] = useState(false);
  const [showDeleteMultiAlert, setShowDeleteMultiAlert] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useAtom(propertiesPanelActiveTabAtom);
  const validActiveTab =
    activeTab === "runs" && isOwner ? "runs" : "properties";
  const refreshRunsRef = useRef<(() => Promise<void>) | null>(null);
  const autoSelectAbortControllersRef = useRef<Record<string, AbortController>>(
    {}
  );
  const workflowNameSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);

  // Count multiple selections
  const selectedNodes = nodes.filter((node) => node.selected);
  const selectedEdges = edges.filter((edge) => edge.selected);
  const hasMultipleSelections = selectedNodes.length + selectedEdges.length > 1;

  // Build multi-selection text
  const selectionText = (() => {
    const parts: string[] = [];
    if (selectedNodes.length > 0) {
      parts.push(
        `${selectedNodes.length} ${selectedNodes.length === 1 ? "node" : "nodes"}`
      );
    }
    if (selectedEdges.length > 0) {
      parts.push(
        `${selectedEdges.length} ${selectedEdges.length === 1 ? "line" : "lines"}`
      );
    }
    return parts.join(" and ");
  })();

  // Auto-fix invalid integration references when a node is selected
  const globalIntegrations = useAtomValue(integrationsAtom);
  useEffect(() => {
    if (!(selectedNode && isOwner)) {
      return;
    }

    const actionType = getConfigString(selectedNode.data.config, "actionType");
    const currentIntegrationId = getConfigString(
      selectedNode.data.config,
      "integrationId"
    );

    if (!(actionType && currentIntegrationId)) {
      return;
    }

    const integrationType = getActionIntegrationType(actionType);

    if (!integrationType) {
      return;
    }

    const integrationExists = globalIntegrations.some(
      (i) => i.id === currentIntegrationId
    );

    if (integrationExists) {
      return;
    }

    const availableIntegrations = globalIntegrations.filter(
      (i) => i.type === integrationType
    );

    if (availableIntegrations.length === 1) {
      const newConfig = {
        ...selectedNode.data.config,
        integrationId: availableIntegrations[0].id,
      };
      updateNodeData({ id: selectedNode.id, data: { config: newConfig } });
    } else if (availableIntegrations.length === 0) {
      const newConfig = {
        ...selectedNode.data.config,
        integrationId: undefined,
      };
      updateNodeData({ id: selectedNode.id, data: { config: newConfig } });
    }
  }, [selectedNode, globalIntegrations, isOwner, updateNodeData]);

  const handleDelete = () => {
    if (selectedNodeId) {
      deleteNode(selectedNodeId);
      setShowDeleteNodeAlert(false);
    }
  };

  const handleToggleEnabled = () => {
    if (selectedNode) {
      const currentEnabled = selectedNode.data.enabled ?? true;
      updateNodeData({
        id: selectedNode.id,
        data: { enabled: !currentEnabled },
      });
    }
  };

  const handleDeleteEdge = () => {
    if (selectedEdgeId) {
      deleteEdge(selectedEdgeId);
      setShowDeleteEdgeAlert(false);
    }
  };

  const handleDeleteMulti = () => {
    deleteSelectedItems();
    setShowDeleteMultiAlert(false);
  };

  const handleDeleteAllRuns = async () => {
    if (!currentWorkflowId) {
      return;
    }

    try {
      await api.workflow.deleteExecutions(currentWorkflowId);
      clearNodeStatuses();
      setShowDeleteRunsAlert(false);
    } catch (error) {
      console.error("Failed to delete runs:", error);
      const errorMessage =
        error instanceof Error ? error.message : "Failed to delete runs";
      toast.error(errorMessage);
    }
  };

  const handleUpdateLabel = (label: string) => {
    if (selectedNode) {
      updateNodeData({ id: selectedNode.id, data: { label } });
    }
  };

  const handleUpdateDescription = (description: string) => {
    if (selectedNode) {
      updateNodeData({ id: selectedNode.id, data: { description } });
    }
  };

  const autoSelectIntegration = useCallback(
    async (
      nodeId: string,
      actionType: string,
      currentConfig: Record<string, unknown>,
      abortSignal: AbortSignal
    ) => {
      const integrationType = getActionIntegrationType(actionType);

      if (!integrationType) {
        setPendingIntegrationNodes((prev: Set<string>) => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
        return;
      }

      try {
        const all = await api.integration.getAll({});

        if (abortSignal.aborted) {
          return;
        }

        const filtered = all.filter((i) => i.type === integrationType);

        if (filtered.length === 1 && !abortSignal.aborted) {
          const newConfig = {
            ...currentConfig,
            actionType,
            integrationId: filtered[0].id,
          };
          updateNodeData({ id: nodeId, data: { config: newConfig } });
        }
      } catch (error) {
        console.error("Failed to auto-select integration:", error);
      } finally {
        if (!abortSignal.aborted) {
          setPendingIntegrationNodes((prev: Set<string>) => {
            const next = new Set(prev);
            next.delete(nodeId);
            return next;
          });
        }
      }
    },
    [updateNodeData, setPendingIntegrationNodes]
  );

  const handleUpdateConfig = (key: string, value: unknown) => {
    if (!selectedNode) {
      return;
    }

    const latestNodes = store.get(nodesAtom);
    const latestNode = latestNodes.find((node) => node.id === selectedNode.id);
    if (!latestNode) {
      return;
    }

    const isActionTypeUpdate =
      key === "actionType" && typeof value === "string";
    const shouldClearIntegration =
      isActionTypeUpdate && Boolean(latestNode.data.config?.integrationId);

    const newConfig: Record<string, unknown> = {
      ...latestNode.data.config,
      [key]: value,
      ...(shouldClearIntegration ? { integrationId: undefined } : {}),
    };

    updateNodeData({ id: selectedNode.id, data: { config: newConfig } });

    if (!isActionTypeUpdate) {
      return;
    }

    const existingController =
      autoSelectAbortControllersRef.current[selectedNode.id];
    if (existingController) {
      existingController.abort();
    }

    const newController = new AbortController();
    autoSelectAbortControllersRef.current[selectedNode.id] = newController;

    setPendingIntegrationNodes((prev: Set<string>) =>
      new Set(prev).add(selectedNode.id)
    );
    autoSelectIntegration(
      selectedNode.id,
      value,
      newConfig,
      newController.signal
    );
  };

  const handleUpdateWorkspaceName = (newName: string) => {
    setCurrentWorkflowName(newName);
    setWorkflowNameError(null);

    if (workflowNameSaveTimeoutRef.current) {
      clearTimeout(workflowNameSaveTimeoutRef.current);
      workflowNameSaveTimeoutRef.current = null;
    }

    if (currentWorkflowId) {
      workflowNameSaveTimeoutRef.current = setTimeout(async () => {
        try {
          await api.workflow.update(currentWorkflowId, {
            name: newName,
          });
        } catch (error) {
          console.error("Failed to update workflow name:", error);
          const message =
            error instanceof ApiError
              ? error.message
              : "Failed to update workflow name";
          setWorkflowNameError(message);
        }
      }, 700);
    }
  };

  useEffect(
    () => () => {
      if (workflowNameSaveTimeoutRef.current) {
        clearTimeout(workflowNameSaveTimeoutRef.current);
      }
    },
    []
  );

  const handleRefreshRuns = async () => {
    setIsRefreshing(true);
    try {
      if (refreshRunsRef.current) {
        await refreshRunsRef.current();
      }
    } catch (error) {
      console.error("Failed to refresh runs:", error);
      toast.error("Failed to refresh runs");
    } finally {
      setIsRefreshing(false);
    }
  };

  // Show action grid for unconfigured owner action nodes
  const showActionGrid =
    selectedNode?.data.type === "action" &&
    !selectedNode.data.config?.actionType &&
    isOwner;

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Multi-branch panel content with conditional rendering
  const renderPropertiesContent = () => {
    // Multi-selection content
    if (hasMultipleSelections) {
      return (
        <div className="space-y-4 p-4">
          <div className="space-y-2">
            <Label>Selection</Label>
            <p className="text-muted-foreground text-sm">
              {selectionText} selected
            </p>
          </div>
          <div className="flex items-center gap-2 pt-4">
            <Button
              onClick={() => setShowDeleteMultiAlert(true)}
              size="sm"
              variant="outline"
            >
              <Trash2 className="mr-2 size-4 text-destructive" />
              <span className="text-destructive">Delete</span>
            </Button>
          </div>
        </div>
      );
    }

    // Edge properties
    if (selectedEdge) {
      return (
        <div className="space-y-4 p-4">
          <div className="space-y-2">
            <Label htmlFor="edge-id">Edge ID</Label>
            <Input disabled id="edge-id" value={selectedEdge.id} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edge-source">Source</Label>
            <Input disabled id="edge-source" value={selectedEdge.source} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edge-target">Target</Label>
            <Input disabled id="edge-target" value={selectedEdge.target} />
          </div>

          {isOwner ? (
            <div className="flex items-center gap-2 pt-4">
              <Button
                onClick={() => setShowDeleteEdgeAlert(true)}
                size="sm"
                variant="outline"
              >
                <Trash2 className="mr-2 size-4 text-destructive" />
                <span className="text-destructive">Delete</span>
              </Button>
            </div>
          ) : null}
        </div>
      );
    }

    // Workspace properties (no node selected)
    if (!selectedNode) {
      return (
        <div className="space-y-4 p-4">
          <div className="space-y-2">
            <Label htmlFor="workflow-name">Workflow Name</Label>
            <Input
              className={workflowNameError ? "border-destructive" : undefined}
              disabled={!isOwner}
              id="workflow-name"
              onChange={(e) => handleUpdateWorkspaceName(e.target.value)}
              value={currentWorkflowName}
            />
            {workflowNameError ? (
              <p className="text-destructive text-xs">{workflowNameError}</p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="workflow-id">Workflow ID</Label>
            <Input
              disabled
              id="workflow-id"
              value={currentWorkflowId || "Not saved"}
            />
          </div>
          {isOwner ? null : (
            <div className="rounded-lg border border-muted bg-muted/30 p-3">
              <p className="text-muted-foreground text-sm">
                You are viewing a public workflow. Duplicate it to make changes.
              </p>
            </div>
          )}
          {isOwner ? (
            <div className="flex items-center gap-2 pt-4">
              <Button
                className="text-muted-foreground"
                onClick={() => setShowClearDialog(true)}
                size="sm"
                variant="ghost"
              >
                <Eraser className="mr-2 size-4" />
                Clear
              </Button>
              <Button
                onClick={() => setShowDeleteDialog(true)}
                size="sm"
                variant="outline"
              >
                <Trash2 className="mr-2 size-4 text-destructive" />
                <span className="text-destructive">Delete</span>
              </Button>
            </div>
          ) : null}
        </div>
      );
    }

    // Action grid for unconfigured action nodes
    if (showActionGrid) {
      return (
        <div className="px-4 pt-4">
          <ActionGrid
            disabled={isGenerating}
            isNewlyCreated={selectedNode?.id === newlyCreatedNodeId}
            onSelectAction={(actionType) => {
              handleUpdateConfig("actionType", actionType);
              if (selectedNode?.id === newlyCreatedNodeId) {
                setNewlyCreatedNodeId(null);
              }
            }}
          />
        </div>
      );
    }

    // Node properties
    return (
      <div className="space-y-4 p-4">
        {selectedNode.data.type === "trigger" ? (
          <TriggerConfig
            config={selectedNode.data.config || {}}
            disabled={isGenerating || !isOwner}
            onUpdateConfig={handleUpdateConfig}
            workflowId={currentWorkflowId ?? undefined}
          />
        ) : null}

        {selectedNode.data.type === "action" &&
        !selectedNode.data.config?.actionType &&
        !isOwner ? (
          <div className="rounded-lg border border-muted bg-muted/30 p-3">
            <p className="text-muted-foreground text-sm">
              No action configured for this step.
            </p>
          </div>
        ) : null}

        {selectedNode.data.type === "action" &&
        selectedNode.data.config?.actionType ? (
          <ActionConfig
            config={selectedNode.data.config || {}}
            disabled={isGenerating || !isOwner}
            isOwner={isOwner}
            onUpdateConfig={handleUpdateConfig}
          />
        ) : null}

        {selectedNode.data.type !== "action" ||
        selectedNode.data.config?.actionType ? (
          <div
            className={
              selectedNode.data.type === "trigger"
                ? "space-y-3 rounded-md border border-muted/70 bg-muted/20 p-3"
                : "space-y-4"
            }
          >
            {selectedNode.data.type === "trigger" ? (
              <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                Node Metadata
              </p>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="label">Label</Label>
              <Input
                disabled={isGenerating || !isOwner}
                id="label"
                onChange={(e) => handleUpdateLabel(e.target.value)}
                value={selectedNode.data.label}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Input
                disabled={isGenerating || !isOwner}
                id="description"
                onChange={(e) => handleUpdateDescription(e.target.value)}
                placeholder="Optional description"
                value={selectedNode.data.description || ""}
              />
            </div>
          </div>
        ) : null}

        {isOwner ? null : (
          <div className="rounded-lg border border-muted bg-muted/30 p-3">
            <p className="text-muted-foreground text-sm">
              You are viewing a public workflow. Duplicate it to make changes.
            </p>
          </div>
        )}

        {isOwner ? (
          <div className="flex items-center gap-2 pt-4">
            {selectedNode.data.type === "action" ? (
              <Button onClick={handleToggleEnabled} size="sm" variant="outline">
                {selectedNode.data.enabled === false ? (
                  <>
                    <EyeOff className="mr-2 size-4" />
                    Disabled
                  </>
                ) : (
                  <>
                    <Eye className="mr-2 size-4" />
                    Enabled
                  </>
                )}
              </Button>
            ) : null}
            <Button
              onClick={() => setShowDeleteNodeAlert(true)}
              size="sm"
              variant="outline"
            >
              <Trash2 className="mr-2 size-4 text-destructive" />
              <span className="text-destructive">Delete</span>
            </Button>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <div className="flex size-full flex-col" data-testid="properties-panel">
        {/* Tab bar - rendered once */}
        <div className="shrink-0 border-b px-4 py-2.5">
          <div className="inline-flex h-9 w-full items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground">
            <button
              className={`inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center rounded-sm px-2 py-1 font-medium text-sm transition-[color,box-shadow] ${
                validActiveTab === "properties"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground"
              }`}
              onClick={() => setActiveTab("properties")}
              type="button"
            >
              Properties
            </button>
            {isOwner ? (
              <button
                className={`inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center rounded-sm px-2 py-1 font-medium text-sm transition-[color,box-shadow] ${
                  validActiveTab === "runs"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground"
                }`}
                onClick={() => setActiveTab("runs")}
                type="button"
              >
                Runs
              </button>
            ) : null}
          </div>
        </div>

        {/* Properties tab */}
        {validActiveTab === "properties" ? (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable_both-edges]">
            {renderPropertiesContent()}
          </div>
        ) : null}

        {/* Runs tab */}
        {isOwner && validActiveTab === "runs" ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center justify-between border-b px-4 py-2">
              <span className="font-medium text-sm">Runs</span>
              <div className="flex items-center gap-2">
                <Button
                  disabled={isRefreshing}
                  onClick={handleRefreshRuns}
                  size="sm"
                  variant="outline"
                >
                  <RefreshCw
                    className={`mr-2 size-4 ${isRefreshing ? "animate-spin" : ""}`}
                  />
                  Refresh
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable_both-edges]">
              <div className="space-y-4 p-4">
                <WorkflowRuns
                  isActive={validActiveTab === "runs"}
                  onRefreshRef={refreshRunsRef}
                />
              </div>
              <div className="border-t px-4 py-3">
                <Button
                  className="text-muted-foreground"
                  onClick={() => setShowDeleteRunsAlert(true)}
                  size="sm"
                  variant="ghost"
                >
                  <Eraser className="mr-2 size-4" />
                  Clear All
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* Delete confirmation dialogs */}
      <DeleteConfirmDialog
        description="Are you sure you want to delete this node? This action cannot be undone."
        onConfirm={handleDelete}
        onOpenChange={setShowDeleteNodeAlert}
        open={showDeleteNodeAlert}
        title="Delete Step"
      />

      <DeleteConfirmDialog
        description="Are you sure you want to delete this connection? This action cannot be undone."
        onConfirm={handleDeleteEdge}
        onOpenChange={setShowDeleteEdgeAlert}
        open={showDeleteEdgeAlert}
        title="Delete Edge"
      />

      <DeleteConfirmDialog
        description="Are you sure you want to delete all workflow runs? This action cannot be undone."
        onConfirm={handleDeleteAllRuns}
        onOpenChange={setShowDeleteRunsAlert}
        open={showDeleteRunsAlert}
        title="Delete All Runs"
      />

      <DeleteConfirmDialog
        description={`Are you sure you want to delete ${selectionText}? This action cannot be undone.`}
        onConfirm={handleDeleteMulti}
        onOpenChange={setShowDeleteMultiAlert}
        open={showDeleteMultiAlert}
        title="Delete Selected Items"
      />
    </>
  );
};

export const NodeConfigPanel = () => (
  <aside className="hidden size-full flex-col overflow-hidden bg-card md:flex">
    <PanelInner />
  </aside>
);
