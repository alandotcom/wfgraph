import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  Eraser,
  Eye,
  EyeOff,
  Play,
  RefreshCw,
  Settings2,
  Trash2,
  Ungroup,
} from "lucide-react";
import { Button } from "#src/components/ui/button";
import { Input } from "#src/components/ui/input";
import { Label } from "#src/components/ui/label";
import { useDeleteWorkflow } from "#src/hooks/use-delete-workflow";
import {
  clearWorkflowAtom,
  deleteEdgeAtom,
  deleteNodeAtom,
  deleteSelectedItemsAtom,
  edgesAtom,
  newlyCreatedNodeIdAtom,
  nodesAtom,
  selectedEdgeAtom,
  selectedNodeAtom,
  setGroupEnabledAtom,
  ungroupNodeAtom,
  updateNodeDataAtom,
} from "#src/lib/workflow-graph-store";
import { canUngroup, refuseDelete } from "#src/lib/node-group";
import {
  disabledGroupIds,
  isGroupNode,
} from "@wfgraph/shared/graph/node-group";
import {
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  isWorkflowOwnerAtom,
  renameWorkflowAtom,
  workflowNameErrorAtom,
} from "#src/lib/workflow-save-store";
import {
  activePropertiesTabAtom,
  isGeneratingAtom,
  propertiesPanelActiveTabAtom,
} from "#src/lib/workflow-ui-store";
import { ActionConfig } from "./config/action-config";
import { ActionGrid } from "./config/action-grid";
import { LifecyclePanel } from "./config/lifecycle-panel";
import { useNodeConfigWriter } from "./config/use-node-config-writer";
import { WorkflowRuns } from "./workflow-runs";

/**
 * Configuring the selected node, edge, or the workflow itself.
 *
 * The editor mounts this in two places: the right rail on a wide viewport, and
 * a sheet from the toolbar's Configuration button or from the issues overlay.
 * Everything the two placements share is here; what a frame genuinely owns is
 * `NodeConfigFrame`.
 */

/** A destructive action the user has to agree to before it happens. */
export type ConfirmRequest = {
  title: string;
  message: string;
  /** Wording on the button that goes through with it. */
  confirmLabel: string;
  onConfirm: () => void;
};

/** What the panel cannot decide for itself, because the frame around it owns it. */
export type NodeConfigFrame = {
  /** How this frame asks the user to confirm. */
  confirm: (request: ConfirmRequest) => void;
  /**
   * Close the frame, once what it was configuring no longer exists. A frame
   * that is always on screen, like the rail, leaves this unset.
   */
  dismiss?: () => void;
  /**
   * Where the tab switcher sits: above the content in a rail, at the bottom of
   * a sheet where a thumb reaches it.
   */
  tabs: "top" | "bottom";
};

/**
 * The tab to render, which is the stored one unless it is the owner-only Runs
 * tab and the viewer is not the owner. The derivation lives on
 * `activePropertiesTabAtom` so the canvas overlay cannot disagree.
 */
function useValidActiveTab() {
  const validActiveTab = useAtomValue(activePropertiesTabAtom);
  const setActiveTab = useSetAtom(propertiesPanelActiveTabAtom);
  return { validActiveTab, setActiveTab } as const;
}

/**
 * What the panel is currently configuring, for a frame that shows a title.
 * Derived here so the header and the tab switcher cannot disagree.
 */
export function useNodeConfigTitle(): string {
  const { validActiveTab } = useValidActiveTab();
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const selectedEdgeId = useAtomValue(selectedEdgeAtom);

  if (validActiveTab === "runs") {
    return "Runs";
  }
  if (selectedNodeId) {
    return "Properties";
  }
  return selectedEdgeId ? "Connection" : "Workflow";
}

type TabBarProps = {
  placement: NodeConfigFrame["tabs"];
  activeTab: string;
  onSelect: (tab: string) => void;
  /** "Workflow" when nothing on the canvas is selected, "Properties" otherwise. */
  propertiesLabel: string;
  showRuns: boolean;
};

function TabBar({
  placement,
  activeTab,
  onSelect,
  propertiesLabel,
  showRuns,
}: TabBarProps) {
  if (placement === "bottom") {
    return (
      <div className="flex shrink-0 items-center justify-around border-t bg-background pb-safe">
        <button
          className={`flex flex-1 flex-col items-center gap-1 py-3 font-medium text-xs transition-colors ${
            activeTab === "properties"
              ? "text-foreground"
              : "text-muted-foreground"
          }`}
          onClick={() => onSelect("properties")}
          type="button"
        >
          <Settings2 className="size-5" />
          {propertiesLabel}
        </button>
        {showRuns ? (
          <button
            className={`flex flex-1 flex-col items-center gap-1 py-3 font-medium text-xs transition-colors ${
              activeTab === "runs" ? "text-foreground" : "text-muted-foreground"
            }`}
            onClick={() => onSelect("runs")}
            type="button"
          >
            <Play className="size-5" />
            Runs
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="shrink-0 border-b px-4 py-2.5">
      <div className="inline-flex h-9 w-full items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground">
        <button
          className={`inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center rounded-sm px-2 py-1 font-medium text-sm transition-[color,box-shadow] ${
            activeTab === "properties"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground"
          }`}
          onClick={() => onSelect("properties")}
          type="button"
        >
          {propertiesLabel}
        </button>
        {showRuns ? (
          <button
            className={`inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center rounded-sm px-2 py-1 font-medium text-sm transition-[color,box-shadow] ${
              activeTab === "runs"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground"
            }`}
            onClick={() => onSelect("runs")}
            type="button"
          >
            Runs
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function NodeConfigPanel({ frame }: { frame: NodeConfigFrame }) {
  const {
    updateConfig: handleUpdateConfig,
    refreshRuns: handleRefreshRuns,
    deleteRuns,
  } = useNodeConfigWriter();
  const { validActiveTab, setActiveTab } = useValidActiveTab();
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const selectedEdgeId = useAtomValue(selectedEdgeAtom);
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const isGenerating = useAtomValue(isGeneratingAtom);
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const currentWorkflowName = useAtomValue(currentWorkflowNameAtom);
  const renameWorkflow = useSetAtom(renameWorkflowAtom);
  const [workflowNameError, setWorkflowNameError] = useAtom(
    workflowNameErrorAtom
  );
  const isOwner = useAtomValue(isWorkflowOwnerAtom);
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const deleteNode = useSetAtom(deleteNodeAtom);
  const ungroupSelected = useSetAtom(ungroupNodeAtom);
  const setGroupEnabled = useSetAtom(setGroupEnabledAtom);
  const deleteEdge = useSetAtom(deleteEdgeAtom);
  const deleteSelectedItems = useSetAtom(deleteSelectedItemsAtom);
  const clearWorkflow = useSetAtom(clearWorkflowAtom);
  const deleteWorkflow = useDeleteWorkflow();
  const [newlyCreatedNodeId, setNewlyCreatedNodeId] = useAtom(
    newlyCreatedNodeIdAtom
  );

  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);

  const selectedNodes = nodes.filter((node) => node.selected);
  const selectedEdges = edges.filter((edge) => edge.selected);
  const hasMultipleSelections = selectedNodes.length + selectedEdges.length > 1;

  const selectionText = (() => {
    const parts: string[] = [];
    if (selectedNodes.length > 0) {
      parts.push(
        `${selectedNodes.length} ${selectedNodes.length === 1 ? "step" : "steps"}`
      );
    }
    if (selectedEdges.length > 0) {
      parts.push(
        `${selectedEdges.length} ${selectedEdges.length === 1 ? "connection" : "connections"}`
      );
    }
    return parts.join(" and ");
  })();

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

  const frameDisabled =
    selectedNode && isGroupNode(selectedNode)
      ? disabledGroupIds(nodes).has(selectedNode.id)
      : false;
  const showDisabledToggle = Boolean(
    selectedNode &&
    !selectedNode.parentId &&
    (selectedNode.data.type === "action" || isGroupNode(selectedNode))
  );
  const isSelectionDisabled = selectedNode
    ? isGroupNode(selectedNode)
      ? frameDisabled
      : selectedNode.data.enabled === false
    : false;

  const handleToggleEnabled = () => {
    if (!selectedNode) {
      return;
    }
    if (isGroupNode(selectedNode)) {
      setGroupEnabled({
        groupId: selectedNode.id,
        enabled: frameDisabled,
      });
      return;
    }
    updateNodeData({
      id: selectedNode.id,
      data: { enabled: selectedNode.data.enabled === false },
    });
  };

  const handleUpdateWorkflowName = async (newName: string) => {
    // Debounced inside the save queue, which also merges the rename with any
    // graph edit pending in the same window into a single request.
    const error = await renameWorkflow(newName);
    if (error) {
      setWorkflowNameError(error.message || "Failed to update workflow name");
    }
  };

  const confirmDeleteNode = () => {
    if (!selectedNode) {
      return;
    }
    const nodeId = selectedNode.id;
    frame.confirm({
      title: "Delete Step",
      message:
        "Are you sure you want to delete this step? This action cannot be undone.",
      confirmLabel: "Delete",
      onConfirm: () => {
        deleteNode(nodeId);
        frame.dismiss?.();
      },
    });
  };

  const confirmDeleteEdge = () => {
    if (!selectedEdgeId) {
      return;
    }
    frame.confirm({
      title: "Delete Connection",
      message:
        "Are you sure you want to delete this connection? This action cannot be undone.",
      confirmLabel: "Delete",
      onConfirm: () => {
        deleteEdge(selectedEdgeId);
        frame.dismiss?.();
      },
    });
  };

  const confirmDeleteSelection = () => {
    frame.confirm({
      title: "Delete Selected Items",
      message: `Are you sure you want to delete ${selectionText}? This action cannot be undone.`,
      confirmLabel: "Delete",
      onConfirm: () => {
        deleteSelectedItems();
        frame.dismiss?.();
      },
    });
  };

  const confirmDeleteAllRuns = () => {
    frame.confirm({
      title: "Delete All Runs",
      message:
        "Are you sure you want to delete all workflow runs? This action cannot be undone.",
      confirmLabel: "Delete",
      onConfirm: () => {
        if (currentWorkflowId) {
          deleteRuns.mutate({ workflowId: currentWorkflowId });
        }
      },
    });
  };

  const confirmClearWorkflow = () => {
    frame.confirm({
      title: "Clear Workflow",
      message:
        "Remove every step and connection? The Lifecycle Node is kept, and this saves right away.",
      confirmLabel: "Clear Workflow",
      onConfirm: () => clearWorkflow(),
    });
  };

  const confirmDeleteWorkflow = () => {
    frame.confirm({
      title: "Delete Workflow",
      message: `Are you sure you want to delete "${currentWorkflowName}"? This will permanently delete the workflow. This cannot be undone.`,
      confirmLabel: "Delete Workflow",
      onConfirm: () => {
        if (!currentWorkflowId) {
          return;
        }
        // The overlay stack sits above the router, so a sheet survives the
        // hook's navigation and has to be closed by hand once the delete lands.
        deleteWorkflow.mutate(
          { workflowId: currentWorkflowId },
          { onSuccess: () => frame.dismiss?.() }
        );
      },
    });
  };

  // An action node with no action chosen yet gets the picker instead of a
  // config form, and the picker is the whole screen while it is up.
  const showActionGrid =
    selectedNode?.data.type === "action" &&
    !selectedNode.data.config?.actionType &&
    isOwner;

  const publicWorkflowNotice = (
    <div className="rounded-lg border border-muted bg-muted/30 p-3">
      <p className="text-muted-foreground text-sm">
        You are viewing a public workflow. Duplicate it to make changes.
      </p>
    </div>
  );

  const renderPropertiesContent = () => {
    if (hasMultipleSelections) {
      return (
        <div className="space-y-4 p-4">
          <div className="space-y-2">
            <Label>Selection</Label>
            <p className="text-muted-foreground text-sm">
              {selectionText} selected
            </p>
          </div>
          {isOwner ? (
            <div className="flex items-center gap-2 pt-4">
              <Button
                onClick={confirmDeleteSelection}
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

    if (selectedEdge && !selectedNode) {
      return (
        <div className="space-y-4 p-4">
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

          {isOwner ? (
            <div className="flex items-center gap-2 pt-4">
              <Button onClick={confirmDeleteEdge} size="sm" variant="outline">
                <Trash2 className="mr-2 size-4 text-destructive" />
                <span className="text-destructive">Delete</span>
              </Button>
            </div>
          ) : null}
        </div>
      );
    }

    // Workflow-level properties, which is what nothing being selected means.
    if (!selectedNode) {
      return (
        <div className="space-y-4 p-4">
          <div className="space-y-2">
            <Label htmlFor="workflow-name">Workflow Name</Label>
            <Input
              className={workflowNameError ? "border-destructive" : undefined}
              disabled={!isOwner}
              id="workflow-name"
              onChange={(e) => handleUpdateWorkflowName(e.target.value)}
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
          {isOwner ? null : publicWorkflowNotice}
          {isOwner ? (
            <div className="flex items-center gap-2 pt-4">
              <Button
                className="text-muted-foreground"
                onClick={confirmClearWorkflow}
                size="sm"
                variant="ghost"
              >
                <Eraser className="mr-2 size-4" />
                Clear
              </Button>
              <Button
                onClick={confirmDeleteWorkflow}
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

    if (showActionGrid) {
      return (
        <div className="px-4 pt-4">
          <ActionGrid
            disabled={isGenerating}
            isNewlyCreated={selectedNode.id === newlyCreatedNodeId}
            // A grid keyed to the node it configures starts fresh for each
            // one: the search box empties, and a node dropped moments ago gets
            // the autofocus that only fires on mount.
            key={selectedNode.id}
            onSelectAction={(actionType) => {
              handleUpdateConfig({ actionType });
              if (selectedNode.id === newlyCreatedNodeId) {
                setNewlyCreatedNodeId(null);
              }
            }}
          />
        </div>
      );
    }

    return (
      <div className="space-y-4 p-4">
        {selectedNode.data.type === "group" ? (
          <p className="text-muted-foreground text-sm">
            Lookups and a Condition in a single-entry, single-exit frame.
            Lookups may run side by side and join at the Condition. True
            continues; False with no outgoing edge ends that path.
          </p>
        ) : null}

        {selectedNode.data.type === "lifecycle" ? (
          /* The Lifecycle Rules are the whole of the entry node's configuration.
             The payload shape is not asked for here: it belongs to the Events the
             rules name, and the editor derives the fields it offers from them. */
          <LifecyclePanel
            config={selectedNode.data.config || {}}
            disabled={isGenerating || !isOwner}
            onUpdateConfig={handleUpdateConfig}
          />
        ) : null}

        {selectedNode.data.type === "action" &&
        !selectedNode.data.config?.actionType ? (
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
            key={selectedNode.id}
            onUpdateConfig={handleUpdateConfig}
          />
        ) : null}

        {selectedNode.data.type !== "action" ||
        selectedNode.data.config?.actionType ? (
          <div
            className={
              selectedNode.data.type === "lifecycle"
                ? "space-y-3 rounded-md border border-muted/70 bg-muted/20 p-3"
                : "space-y-4"
            }
          >
            {selectedNode.data.type === "lifecycle" ? (
              <p className="font-medium text-muted-foreground text-sm">
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

        {isOwner ? null : publicWorkflowNotice}

        {isOwner && selectedNode.parentId ? (
          <p className="pt-4 text-muted-foreground text-xs">
            This step runs with its Group. Select the frame to switch it off.
          </p>
        ) : null}

        {isOwner ? (
          <div className="flex items-center gap-2 pt-4">
            {showDisabledToggle ? (
              <Button onClick={handleToggleEnabled} size="sm" variant="outline">
                {isSelectionDisabled ? (
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
            {canUngroup(selectedNode) ? (
              <Button
                onClick={() => ungroupSelected(selectedNode.id)}
                size="sm"
                variant="outline"
              >
                <Ungroup className="mr-2 size-4" />
                Ungroup
              </Button>
            ) : null}
            {/* A member is deleted by deleting or ungrouping its frame, which
                is what keeps the frame's entry and exit naming a live step. */}
            {refuseDelete([selectedNode]) ? null : (
              <Button onClick={confirmDeleteNode} size="sm" variant="outline">
                <Trash2 className="mr-2 size-4 text-destructive" />
                <span className="text-destructive">Delete</span>
              </Button>
            )}
          </div>
        ) : null}
      </div>
    );
  };

  const tabBar = (
    <TabBar
      activeTab={validActiveTab}
      onSelect={setActiveTab}
      placement={frame.tabs}
      propertiesLabel={
        selectedNode || selectedEdge || hasMultipleSelections
          ? "Properties"
          : "Workflow"
      }
      showRuns={isOwner}
    />
  );

  return (
    // `flex-1` rather than a full height: both frames are flex columns, and the
    // sheet puts a header above this.
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="properties-panel"
    >
      {frame.tabs === "top" ? tabBar : null}

      {validActiveTab === "properties" ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable_both-edges]">
          {renderPropertiesContent()}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
            <Button onClick={handleRefreshRuns} size="sm" variant="outline">
              <RefreshCw className="mr-2 size-4" />
              Refresh
            </Button>
            <Button
              className="text-muted-foreground"
              onClick={confirmDeleteAllRuns}
              size="sm"
              variant="ghost"
            >
              <Eraser className="mr-2 size-4" />
              Clear All
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 [scrollbar-gutter:stable_both-edges]">
            <WorkflowRuns />
          </div>
        </div>
      )}

      {frame.tabs === "bottom" ? tabBar : null}
    </div>
  );
}
