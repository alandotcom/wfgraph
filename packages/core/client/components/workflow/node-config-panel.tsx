import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { Eraser, Eye, EyeOff, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/rpc-client";
import { repairNodeIntegration } from "@/lib/node-integration";
import { integrationsQueryOptions, orpcQuery } from "@/lib/rpc-query";
import {
  clearNodeStatusesAtom,
  deleteEdgeAtom,
  deleteNodeAtom,
  deleteSelectedItemsAtom,
  edgesAtom,
  newlyCreatedNodeIdAtom,
  nodesAtom,
  selectedEdgeAtom,
  selectedNodeAtom,
  updateNodeDataAtom,
} from "@/lib/workflow-graph-store";
import {
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  isWorkflowOwnerAtom,
  renameWorkflowAtom,
  workflowNameErrorAtom,
} from "@/lib/workflow-save-store";
import {
  isGeneratingAtom,
  propertiesPanelActiveTabAtom,
  showClearDialogAtom,
  showDeleteDialogAtom,
} from "@/lib/workflow-ui-store";
import { ActionConfig } from "./config/action-config";
import { ActionGrid } from "./config/action-grid";
import type { NodeConfigPatch } from "./config/node-config-patch";
import { TriggerConfig } from "./config/trigger-config";
import { WorkflowRuns } from "./workflow-runs";

export const PanelInner = () => {
  const store = useStore();
  const queryClient = useQueryClient();
  const [selectedNodeId] = useAtom(selectedNodeAtom);
  const [selectedEdgeId] = useAtom(selectedEdgeAtom);
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const [isGenerating] = useAtom(isGeneratingAtom);
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const currentWorkflowName = useAtomValue(currentWorkflowNameAtom);
  const renameWorkflow = useSetAtom(renameWorkflowAtom);
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
  const [newlyCreatedNodeId, setNewlyCreatedNodeId] = useAtom(
    newlyCreatedNodeIdAtom
  );
  const [showDeleteNodeAlert, setShowDeleteNodeAlert] = useState(false);
  const [showDeleteEdgeAlert, setShowDeleteEdgeAlert] = useState(false);
  const [showDeleteRunsAlert, setShowDeleteRunsAlert] = useState(false);
  const [showDeleteMultiAlert, setShowDeleteMultiAlert] = useState(false);
  const [activeTab, setActiveTab] = useAtom(propertiesPanelActiveTabAtom);
  const validActiveTab =
    activeTab === "runs" && isOwner ? "runs" : "properties";
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

  const { data: globalIntegrations = [] } = useQuery(
    integrationsQueryOptions()
  );

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

  const handleUpdateConfig = (patch: NodeConfigPatch) => {
    if (!selectedNode) {
      return;
    }

    const latestNodes = store.get(nodesAtom);
    const latestNode = latestNodes.find((node) => node.id === selectedNode.id);
    if (!latestNode) {
      return;
    }

    // Picking a different action invalidates whatever connection the previous
    // action was bound to, so the two keys move together.
    const isActionTypeUpdate = typeof patch.actionType === "string";
    const shouldClearIntegration =
      isActionTypeUpdate && Boolean(latestNode.data.config?.integrationId);

    const newConfig: Record<string, unknown> = {
      ...latestNode.data.config,
      ...patch,
      ...(shouldClearIntegration ? { integrationId: undefined } : {}),
    };

    // Choosing an action is exactly when its connection can be settled, and the
    // connection list is already in hand. This used to be a fetch with an abort
    // controller and a "pending" flag to hide the warning that flashed while it
    // was in flight; with the list cached there is no flight and no flash.
    const repaired = repairNodeIntegration(
      { ...latestNode, data: { ...latestNode.data, config: newConfig } },
      globalIntegrations
    );

    updateNodeData({
      id: selectedNode.id,
      data: { config: repaired.data.config },
    });
  };

  const handleUpdateWorkspaceName = async (newName: string) => {
    // Debounced inside the save queue, which also merges the rename with any
    // graph edit pending in the same window into a single request.
    const error = await renameWorkflow(newName);
    if (error) {
      setWorkflowNameError(error.message || "Failed to update workflow name");
    }
  };

  // Refreshing the runs list is a cache invalidation, so it does not need a
  // callback handed up from the panel that owns the list, and the spinner reads
  // the query's own fetching state instead of a boolean kept beside it.
  const isRefreshingRuns =
    useIsFetching({ queryKey: orpcQuery.workflow.getExecutions.key() }) > 0;

  const handleRefreshRuns = () =>
    queryClient.invalidateQueries({
      queryKey: orpcQuery.workflow.getExecutions.key(),
    });

  // Show action grid for unconfigured owner action nodes
  const showActionGrid =
    selectedNode?.data.type === "action" &&
    !selectedNode.data.config?.actionType &&
    isOwner;

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
            // A grid keyed to the node it configures starts fresh for each
            // one: the search box empties, and a node dropped moments ago gets
            // the autofocus that only fires on mount.
            key={selectedNode?.id}
            onSelectAction={(actionType) => {
              handleUpdateConfig({ actionType });
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
                  disabled={isRefreshingRuns}
                  onClick={handleRefreshRuns}
                  size="sm"
                  variant="outline"
                >
                  <RefreshCw
                    className={`mr-2 size-4 ${isRefreshingRuns ? "animate-spin" : ""}`}
                  />
                  Refresh
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable_both-edges]">
              <div className="space-y-4 p-4">
                <WorkflowRuns isActive={validActiveTab === "runs"} />
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
