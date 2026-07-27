import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  Eraser,
  Eye,
  EyeOff,
  Play,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";
import { useCallback } from "react";
import { toast } from "sonner";
import { ConfirmOverlay } from "@/components/overlays/confirm-overlay";
import { SmartOverlayHeader } from "@/components/overlays/overlay-header";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ActionConfig } from "@/components/workflow/config/action-config";
import { useNodeConfigWriter } from "@/components/workflow/config/use-node-config-writer";
import { ActionGrid } from "@/components/workflow/config/action-grid";
import { TriggerConfig } from "@/components/workflow/config/trigger-config";
import { WorkflowRuns } from "@/components/workflow/workflow-runs";
import { api } from "@/lib/rpc-client";
import {
  clearNodeStatusesAtom,
  clearWorkflowAtom,
  deleteEdgeAtom,
  deleteNodeAtom,
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
} from "@/lib/workflow-ui-store";
import type { OverlayComponentProps } from "./types";

type ConfigurationOverlayProps = OverlayComponentProps;

export function ConfigurationOverlay({ overlayId }: ConfigurationOverlayProps) {
  const { updateConfig: handleUpdateConfig, refreshRuns: handleRefreshRuns } =
    useNodeConfigWriter();
  const { push, closeAll } = useOverlay();
  const [selectedNodeId] = useAtom(selectedNodeAtom);
  const [selectedEdgeId] = useAtom(selectedEdgeAtom);
  const [nodes] = useAtom(nodesAtom);
  const [edges] = useAtom(edgesAtom);
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
  const clearNodeStatuses = useSetAtom(clearNodeStatusesAtom);
  const clearWorkflow = useSetAtom(clearWorkflowAtom);
  const [newlyCreatedNodeId, setNewlyCreatedNodeId] = useAtom(
    newlyCreatedNodeIdAtom
  );
  const [activeTab, setActiveTab] = useAtom(propertiesPanelActiveTabAtom);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);

  const handleUpdateLabel = useCallback(
    (label: string) => {
      if (!selectedNode) {
        return;
      }
      updateNodeData({ id: selectedNode.id, data: { label } });
    },
    [selectedNode, updateNodeData]
  );

  const handleUpdateDescription = useCallback(
    (description: string) => {
      if (!selectedNode) {
        return;
      }
      updateNodeData({ id: selectedNode.id, data: { description } });
    },
    [selectedNode, updateNodeData]
  );

  const handleToggleEnabled = useCallback(() => {
    if (!selectedNode) {
      return;
    }
    updateNodeData({
      id: selectedNode.id,
      data: { enabled: selectedNode.data.enabled === false },
    });
  }, [selectedNode, updateNodeData]);

  const handleDeleteNode = useCallback(() => {
    push(ConfirmOverlay, {
      title: "Delete Step",
      message:
        "Are you sure you want to delete this node? This action cannot be undone.",
      confirmLabel: "Delete",
      confirmVariant: "destructive" as const,
      onConfirm: () => {
        if (selectedNode) {
          deleteNode(selectedNode.id);
          closeAll();
        }
      },
    });
  }, [selectedNode, deleteNode, closeAll, push]);

  const handleDeleteAllRuns = () => {
    push(ConfirmOverlay, {
      title: "Delete All Runs",
      message:
        "Are you sure you want to delete all workflow runs? This action cannot be undone.",
      confirmLabel: "Delete",
      confirmVariant: "destructive" as const,
      onConfirm: async () => {
        if (!currentWorkflowId) {
          return;
        }
        try {
          await api.workflow.deleteExecutions(currentWorkflowId);
          clearNodeStatuses();
          await handleRefreshRuns();
          toast.success("All runs deleted");
        } catch (error) {
          console.error("Failed to delete runs:", error);
          toast.error("Failed to delete runs");
        }
      },
    });
  };

  const getTabTitle = () => {
    if (!selectedNode) {
      const validTab = activeTab === "runs" && isOwner ? "runs" : "properties";
      switch (validTab) {
        case "properties":
          return "Workflow";
        case "runs":
          return "Runs";
        default:
          return "Workflow";
      }
    }
    const validTab = activeTab === "runs" && isOwner ? "runs" : "properties";
    switch (validTab) {
      case "properties":
        return "Properties";
      case "runs":
        return "Runs";
      default:
        return "Properties";
    }
  };

  // Handle updating workflow name. Debounced by the save queue, which this
  // shares with the config panel's rename field and with graph autosave.
  const handleUpdateWorkflowName = async (newName: string) => {
    const error = await renameWorkflow(newName);
    if (error) {
      setWorkflowNameError(error.message || "Failed to update workflow name");
    }
  };

  // Handle clear workflow
  const handleClearWorkflow = () => {
    push(ConfirmOverlay, {
      title: "Clear Workflow",
      message:
        "Remove every step and connection? The trigger is kept, and this saves right away.",
      confirmLabel: "Clear Workflow",
      confirmVariant: "destructive" as const,
      destructive: true,
      onConfirm: () => {
        clearWorkflow();
      },
    });
  };

  // Handle delete workflow
  const handleDeleteWorkflow = () => {
    push(ConfirmOverlay, {
      title: "Delete Workflow",
      message: `Are you sure you want to delete "${currentWorkflowName}"? This will permanently delete the workflow. This cannot be undone.`,
      confirmLabel: "Delete Workflow",
      confirmVariant: "destructive" as const,
      destructive: true,
      onConfirm: async () => {
        if (!currentWorkflowId) {
          return;
        }
        try {
          await api.workflow.delete(currentWorkflowId);
          closeAll();
          toast.success("Workflow deleted successfully");
          window.location.href = "/";
        } catch (error) {
          console.error("Failed to delete workflow:", error);
          toast.error("Failed to delete workflow. Please try again.");
        }
      },
    });
  };

  const handleDeleteEdge = () => {
    if (selectedEdgeId) {
      push(ConfirmOverlay, {
        title: "Delete Connection",
        message:
          "Are you sure you want to delete this connection? This action cannot be undone.",
        confirmLabel: "Delete",
        confirmVariant: "destructive" as const,
        onConfirm: () => {
          deleteEdge(selectedEdgeId);
          closeAll();
        },
      });
    }
  };

  // If an edge is selected, show edge properties
  if (selectedEdge && !selectedNode) {
    return (
      <div className="flex h-full max-h-[80vh] flex-col">
        <SmartOverlayHeader overlayId={overlayId} title="Connection" />

        <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain px-6 pt-4 pb-6 [scrollbar-gutter:stable_both-edges]">
          <div className="space-y-2">
            <Label htmlFor="edge-id">Connection ID</Label>
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
          {isOwner && (
            <div className="pt-2">
              <Button onClick={handleDeleteEdge} variant="ghost">
                <Trash2 className="mr-2 size-4" />
                Delete Connection
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // If no node is selected, show workflow-level configuration
  if (!selectedNode) {
    const validWorkflowTab =
      activeTab === "runs" && isOwner ? "runs" : "properties";

    return (
      <div className="flex h-full max-h-[80vh] flex-col">
        <SmartOverlayHeader overlayId={overlayId} title={getTabTitle()} />

        <div className="flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable_both-edges]">
          {validWorkflowTab === "properties" && (
            <div className="space-y-4 px-6 pt-4 pb-6">
              <div className="space-y-2">
                <Label htmlFor="workflow-name">Workflow Name</Label>
                <Input
                  className={
                    workflowNameError ? "border-destructive" : undefined
                  }
                  disabled={!isOwner}
                  id="workflow-name"
                  onChange={(e) => handleUpdateWorkflowName(e.target.value)}
                  value={currentWorkflowName}
                />
                {workflowNameError && (
                  <p className="text-destructive text-xs">
                    {workflowNameError}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="workflow-id">Workflow ID</Label>
                <Input
                  disabled
                  id="workflow-id"
                  value={currentWorkflowId || "Not saved"}
                />
              </div>
              {!isOwner && (
                <div className="rounded-lg border border-muted bg-muted/30 p-3">
                  <p className="text-muted-foreground text-sm">
                    You are viewing a public workflow. Duplicate it to make
                    changes.
                  </p>
                </div>
              )}
              {isOwner && (
                <div className="flex items-center gap-2 pt-2">
                  <Button onClick={handleClearWorkflow} variant="ghost">
                    <Eraser className="mr-2 size-4" />
                    Clear
                  </Button>
                  <Button onClick={handleDeleteWorkflow} variant="ghost">
                    <Trash2 className="mr-2 size-4" />
                    Delete
                  </Button>
                </div>
              )}
            </div>
          )}

          {validWorkflowTab === "runs" && isOwner && (
            <div className="flex h-full flex-col">
              <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
                <Button
                  className="text-muted-foreground"
                  onClick={handleRefreshRuns}
                  size="icon"
                  variant="ghost"
                >
                  <RefreshCw className="size-4" />
                </Button>
                <Button
                  className="text-muted-foreground"
                  onClick={handleDeleteAllRuns}
                  size="icon"
                  variant="ghost"
                >
                  <Eraser className="size-4" />
                </Button>
              </div>
              <div className="flex-1 overflow-y-auto overscroll-contain p-4 [scrollbar-gutter:stable_both-edges]">
                <WorkflowRuns />
              </div>
            </div>
          )}
        </div>

        {/* Bottom tab navigation */}
        <div className="flex shrink-0 items-center justify-around border-t bg-background pb-safe">
          <button
            className={`flex flex-1 flex-col items-center gap-1 py-3 font-medium text-xs transition-colors ${
              validWorkflowTab === "properties"
                ? "text-foreground"
                : "text-muted-foreground"
            }`}
            onClick={() => setActiveTab("properties")}
            type="button"
          >
            <Settings2 className="size-5" />
            Workflow
          </button>
          {isOwner && (
            <button
              className={`flex flex-1 flex-col items-center gap-1 py-3 font-medium text-xs transition-colors ${
                validWorkflowTab === "runs"
                  ? "text-foreground"
                  : "text-muted-foreground"
              }`}
              onClick={() => setActiveTab("runs")}
              type="button"
            >
              <Play className="size-5" />
              Runs
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full max-h-[80vh] flex-col">
      <SmartOverlayHeader overlayId={overlayId} title={getTabTitle()} />

      <div className="flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable_both-edges]">
        {activeTab === "properties" && (
          <div className="space-y-4 px-6 pt-4 pb-6">
            {selectedNode.data.type === "action" &&
              !selectedNode.data.config?.actionType &&
              isOwner && (
                <ActionGrid
                  disabled={isGenerating}
                  isNewlyCreated={selectedNode?.id === newlyCreatedNodeId}
                  // A grid keyed to the node it configures starts fresh for
                  // each one: the search box empties, and a node dropped
                  // moments ago gets the autofocus that only fires on mount.
                  key={selectedNode?.id}
                  onSelectAction={(actionType) => {
                    handleUpdateConfig({ actionType });
                    if (selectedNode?.id === newlyCreatedNodeId) {
                      setNewlyCreatedNodeId(null);
                    }
                  }}
                />
              )}

            {selectedNode.data.type === "trigger" && (
              <TriggerConfig
                config={selectedNode.data.config || {}}
                disabled={isGenerating || !isOwner}
                onUpdateConfig={handleUpdateConfig}
                workflowId={currentWorkflowId ?? undefined}
              />
            )}

            {selectedNode.data.type === "action" &&
              selectedNode.data.config?.actionType !== undefined && (
                <ActionConfig
                  config={selectedNode.data.config || {}}
                  disabled={isGenerating || !isOwner}
                  isOwner={isOwner}
                  onUpdateConfig={handleUpdateConfig}
                />
              )}

            {(selectedNode.data.type !== "action" ||
              selectedNode.data.config?.actionType !== undefined) && (
              <>
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
                    value={selectedNode.data.description ?? ""}
                  />
                </div>
              </>
            )}

            {isOwner && (
              <div className="flex items-center gap-2 pt-2">
                {selectedNode.data.type === "action" && (
                  <Button
                    className="text-muted-foreground"
                    onClick={handleToggleEnabled}
                    size="sm"
                    variant="ghost"
                  >
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
                )}
                <Button
                  className="text-muted-foreground"
                  onClick={handleDeleteNode}
                  size="sm"
                  variant="ghost"
                >
                  <Trash2 className="mr-2 size-4" />
                  Delete
                </Button>
              </div>
            )}
          </div>
        )}

        {activeTab === "runs" && isOwner && (
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
              <Button
                className="text-muted-foreground"
                onClick={handleRefreshRuns}
                size="sm"
                variant="ghost"
              >
                <RefreshCw className="mr-2 size-4" />
                Refresh
              </Button>
              <Button
                className="text-muted-foreground"
                onClick={handleDeleteAllRuns}
                size="sm"
                variant="ghost"
              >
                <Eraser className="mr-2 size-4" />
                Clear All
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto overscroll-contain p-4 [scrollbar-gutter:stable_both-edges]">
              <WorkflowRuns />
            </div>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-around border-t bg-background pb-safe">
        <button
          className={`flex flex-1 flex-col items-center gap-1 py-3 font-medium text-xs transition-colors ${
            activeTab === "properties"
              ? "text-foreground"
              : "text-muted-foreground"
          }`}
          onClick={() => setActiveTab("properties")}
          type="button"
        >
          <Settings2 className="size-5" />
          Properties
        </button>
        {isOwner && (
          <button
            className={`flex flex-1 flex-col items-center gap-1 py-3 font-medium text-xs transition-colors ${
              activeTab === "runs" ? "text-foreground" : "text-muted-foreground"
            }`}
            onClick={() => setActiveTab("runs")}
            type="button"
          >
            <Play className="size-5" />
            Runs
          </button>
        )}
      </div>
    </div>
  );
}
