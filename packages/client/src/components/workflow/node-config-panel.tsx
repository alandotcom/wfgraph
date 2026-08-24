import { useQuery } from "@tanstack/react-query";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  Eraser,
  Eye,
  EyeOff,
  GitCompareArrows,
  MousePointerClick,
  Play,
  RefreshCw,
  Settings2,
  Trash2,
  Ungroup,
} from "lucide-react";
import type { KeyboardEvent } from "react";
import { cn } from "@wfgraph/shared/utils";
import { Button } from "#src/components/ui/button";
import { Input } from "#src/components/ui/input";
import { Label } from "#src/components/ui/label";
import {
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
  isWorkflowOwnerAtom,
} from "#src/lib/workflow-save-store";
import { workflowPublicationQueryOptions } from "#src/lib/rpc-query";
import {
  activePropertiesTabAtom,
  isGeneratingAtom,
  type PropertiesPanelTab,
  propertiesPanelActiveTabAtom,
} from "#src/lib/workflow-ui-store";
import { WorkflowChangesPanel } from "./workflow-changes-panel";
import { WorkflowComparisonPropertiesPanel } from "./comparison-properties";
import { useWorkflowComparisonActions } from "./use-workflow-comparison-actions";
import {
  isComparisonActiveAtom,
  setWorkflowComparisonVisibleAtom,
} from "#src/lib/workflow-comparison-store";
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
 * tabs and the viewer cannot use one. The derivation lives on
 * `activePropertiesTabAtom` so the canvas overlay cannot disagree.
 */
function useValidActiveTab() {
  const validActiveTab = useAtomValue(activePropertiesTabAtom);
  const setActiveTab = useSetAtom(propertiesPanelActiveTabAtom);
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const isOwner = useAtomValue(isWorkflowOwnerAtom);
  const { data: publication } = useQuery({
    ...workflowPublicationQueryOptions(workflowId ?? ""),
    enabled: Boolean(workflowId),
  });
  const changesAvailable = isOwner && Boolean(publication?.isPublished);
  return {
    validActiveTab:
      validActiveTab === "changes" && !changesAvailable
        ? "properties"
        : validActiveTab,
    setActiveTab,
    changesAvailable,
    workflowId,
  } as const;
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
  if (validActiveTab === "changes") {
    return "Changes";
  }
  // An edge on its own is the one selection with a title of its own. Everything
  // else is Properties, including nothing at all: "Workflow" named a set of
  // fields this panel no longer holds.
  if (selectedEdgeId && !selectedNodeId) {
    return "Connection";
  }
  return "Properties";
}

/**
 * Refresh and Clear All for the Runs surface. On the rail they trail the
 * Properties / Runs control; on the sheet they trail the header title. The
 * confirm callback is the frame's, so the rail and the sheet can each ask in
 * their own way.
 */
export function RunsPanelActions({
  confirm,
}: {
  confirm: NodeConfigFrame["confirm"];
}) {
  const { refreshRuns, deleteRuns } = useNodeConfigWriter();
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);

  return (
    <div className="flex shrink-0 items-center">
      <Button
        aria-label="Refresh"
        onClick={refreshRuns}
        size="icon"
        type="button"
        variant="ghost"
      >
        <RefreshCw />
      </Button>
      <Button
        aria-label="Clear All"
        onClick={() => {
          confirm({
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
        }}
        size="icon"
        type="button"
        variant="ghost"
      >
        <Eraser />
      </Button>
    </div>
  );
}

type TabBarProps = {
  placement: NodeConfigFrame["tabs"];
  activeTab: PropertiesPanelTab;
  onSelect: (tab: PropertiesPanelTab) => void;
  showChanges: boolean;
  showRuns: boolean;
};

const WORKFLOW_PANEL_ID = "workflow-properties-panel";

function tabId(tab: PropertiesPanelTab): string {
  return `workflow-properties-tab-${tab}`;
}

function TabBar({
  placement,
  activeTab,
  onSelect,
  showChanges,
  showRuns,
}: TabBarProps) {
  const tabs = [
    "properties" as const,
    ...(showRuns ? (["runs"] as const) : []),
    ...(showChanges ? (["changes"] as const) : []),
  ];
  const selectFromKeyboard = (
    event: KeyboardEvent<HTMLButtonElement>,
    tab: PropertiesPanelTab
  ) => {
    const currentIndex = tabs.indexOf(tab);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : event.key === "ArrowLeft"
            ? (currentIndex - 1 + tabs.length) % tabs.length
            : event.key === "ArrowRight"
              ? (currentIndex + 1) % tabs.length
              : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = tabs[nextIndex];
    onSelect(nextTab);
    event.currentTarget.ownerDocument.getElementById(tabId(nextTab))?.focus();
  };
  const tabProps = (tab: PropertiesPanelTab) => ({
    "aria-controls": WORKFLOW_PANEL_ID,
    "aria-selected": activeTab === tab,
    id: tabId(tab),
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) =>
      selectFromKeyboard(event, tab),
    role: "tab" as const,
    tabIndex: activeTab === tab ? 0 : -1,
  });
  if (placement === "bottom") {
    return (
      <div
        aria-label="Workflow panel"
        className="flex shrink-0 items-center justify-around border-t bg-background pb-safe"
        role="tablist"
      >
        <button
          {...tabProps("properties")}
          className={`flex flex-1 flex-col items-center gap-1 py-3 font-medium text-xs transition-colors ${
            activeTab === "properties"
              ? "text-foreground"
              : "text-muted-foreground"
          }`}
          onClick={() => onSelect("properties")}
          type="button"
        >
          <Settings2 className="size-5" />
          Properties
        </button>
        {showRuns ? (
          <button
            {...tabProps("runs")}
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
        {showChanges ? (
          <button
            {...tabProps("changes")}
            className={`flex flex-1 flex-col items-center gap-1 py-3 font-medium text-xs transition-colors ${
              activeTab === "changes"
                ? "text-foreground"
                : "text-muted-foreground"
            }`}
            onClick={() => onSelect("changes")}
            type="button"
          >
            <GitCompareArrows className="size-5" />
            Changes
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <>
      {/* mira sizes every control in the editor at 28px; this segmented control
           predates that adoption and was 36px with 14px labels, which put the
           panel a density step away from the menu bar directly above it. */}
      <div
        aria-label="Workflow panel"
        className="relative mx-4 my-2 inline-flex h-7 min-w-0 shrink-0 self-stretch items-center justify-center rounded-md bg-muted p-[3px] text-muted-foreground"
        role="tablist"
      >
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-y-[3px] left-[3px] rounded-sm bg-background shadow-sm transition-transform duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:duration-100",
            showChanges
              ? "w-[calc(33.333%-3px)]"
              : showRuns
                ? "w-[calc(50%-3px)]"
                : "w-[calc(100%-6px)]",
            activeTab === "runs" && "translate-x-full",
            activeTab === "changes" && "translate-x-[200%]"
          )}
        />
        <button
          {...tabProps("properties")}
          className={`relative z-10 inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center rounded-sm px-2 font-medium text-xs transition-colors duration-[180ms] ${
            activeTab === "properties"
              ? "text-foreground"
              : "text-muted-foreground"
          }`}
          onClick={() => onSelect("properties")}
          type="button"
        >
          Properties
        </button>
        {showRuns ? (
          <button
            {...tabProps("runs")}
            className={`relative z-10 inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center rounded-sm px-2 font-medium text-xs transition-colors duration-[180ms] ${
              activeTab === "runs" ? "text-foreground" : "text-muted-foreground"
            }`}
            onClick={() => onSelect("runs")}
            type="button"
          >
            Runs
          </button>
        ) : null}
        {showChanges ? (
          <button
            {...tabProps("changes")}
            className={`relative z-10 inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center rounded-sm px-2 font-medium text-xs transition-colors duration-[180ms] ${
              activeTab === "changes"
                ? "text-foreground"
                : "text-muted-foreground"
            }`}
            onClick={() => onSelect("changes")}
            type="button"
          >
            Changes
          </button>
        ) : null}
      </div>
    </>
  );
}

export function NodeConfigPanel({ frame }: { frame: NodeConfigFrame }) {
  const { updateConfig: handleUpdateConfig } = useNodeConfigWriter();
  const { validActiveTab, setActiveTab, changesAvailable, workflowId } =
    useValidActiveTab();
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const selectedEdgeId = useAtomValue(selectedEdgeAtom);
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const isGenerating = useAtomValue(isGeneratingAtom);
  const isOwner = useAtomValue(isWorkflowOwnerAtom);
  const comparisonActive = useAtomValue(isComparisonActiveAtom);
  const setComparisonVisible = useSetAtom(setWorkflowComparisonVisibleAtom);
  const comparisonActions = useWorkflowComparisonActions();
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const deleteNode = useSetAtom(deleteNodeAtom);
  const ungroupSelected = useSetAtom(ungroupNodeAtom);
  const setGroupEnabled = useSetAtom(setGroupEnabledAtom);
  const deleteEdge = useSetAtom(deleteEdgeAtom);
  const deleteSelectedItems = useSetAtom(deleteSelectedItemsAtom);
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

    // Nothing selected. The workflow's own settings moved into the menu beside
    // its name, so this is an empty state rather than a second place to rename
    // or delete the workflow from.
    if (!selectedNode) {
      return (
        <div className="flex min-h-full flex-col items-center justify-center gap-2 p-8 text-center">
          <MousePointerClick className="size-5 text-muted-foreground" />
          <p className="font-medium text-sm">Nothing selected</p>
          <p className="text-muted-foreground text-sm">
            Select a step on the canvas to configure it.
          </p>
          <p className="text-muted-foreground text-xs">
            This workflow's own settings are in the menu beside its name.
          </p>
          {isOwner ? null : publicWorkflowNotice}
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
            Lookups in a frame share an incoming step. They can join at one
            Condition or leave separately for the same target and target handle.
            Only Condition True can continue.
          </p>
        ) : null}

        {selectedNode.data.type === "lifecycle" ? (
          /* The Lifecycle Rules are the whole of the entry node's configuration.
             The payload shape is not asked for here: it belongs to the Events the
             rules name, and the editor derives the fields it offers from them. */
          <LifecyclePanel
            config={selectedNode.data.config || {}}
            disabled={isGenerating || !isOwner}
            // Keyed to the node, which is what scopes the view/edit mode each
            // section holds to the workflow being configured: opening another
            // workflow brings its own entry node, and this starts on view.
            key={selectedNode.id}
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
      onSelect={(tab) => {
        setActiveTab(tab);
        if (workflowId) {
          setComparisonVisible({
            workflowId,
            visible: tab === "changes",
          });
        }
        if (tab === "changes") {
          void comparisonActions.openComparison();
        }
      }}
      placement={frame.tabs}
      showChanges={changesAvailable}
      showRuns={isOwner}
    />
  );

  return (
    // `flex-1` rather than a full height: both frames are flex columns, and the
    // sheet puts a header above this.
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      data-testid="properties-panel"
    >
      {frame.tabs === "top" ? tabBar : null}

      <div
        aria-labelledby={tabId(validActiveTab)}
        className="flex min-h-0 flex-1 flex-col"
        id={WORKFLOW_PANEL_ID}
        role="tabpanel"
      >
        {validActiveTab === "properties" ? (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable_both-edges]">
            {comparisonActive ? (
              <WorkflowComparisonPropertiesPanel />
            ) : (
              renderPropertiesContent()
            )}
          </div>
        ) : validActiveTab === "changes" ? (
          <WorkflowChangesPanel actions={comparisonActions} />
        ) : (
          <div className="min-h-0 flex-1 overflow-hidden">
            <WorkflowRuns
              listActions={
                frame.tabs === "top" ? (
                  <RunsPanelActions confirm={frame.confirm} />
                ) : undefined
              }
            />
          </div>
        )}
      </div>

      {frame.tabs === "bottom" ? tabBar : null}
    </div>
  );
}
