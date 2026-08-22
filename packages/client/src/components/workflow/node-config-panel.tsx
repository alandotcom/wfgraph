import * as stylex from "@stylexjs/stylex";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { colorVars, spacingVars } from "@astryxdesign/core/theme/tokens.stylex";
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
  return (
    <div
      {...stylex.props(
        styles.tabBar,
        placement === "bottom" ? styles.bottomTabBar : styles.topTabBar
      )}
    >
      <SegmentedControl
        label="Configuration view"
        layout="fill"
        onChange={onSelect}
        size={placement === "bottom" ? "lg" : "md"}
        value={activeTab}
      >
        <SegmentedControlItem
          icon={
            placement === "bottom" ? (
              <Icon icon={Settings2} size="sm" />
            ) : undefined
          }
          label={propertiesLabel}
          value="properties"
        />
        {showRuns ? (
          <SegmentedControlItem
            icon={
              placement === "bottom" ? (
                <Icon icon={Play} size="sm" />
              ) : undefined
            }
            label="Runs"
            value="runs"
          />
        ) : null}
      </SegmentedControl>
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
    <Banner
      description="Duplicate it to make changes."
      status="info"
      title="You are viewing a public workflow"
    />
  );

  const renderPropertiesContent = () => {
    if (hasMultipleSelections) {
      return (
        <VStack gap={4} padding={4}>
          <VStack gap={1}>
            <Text type="label">Selection</Text>
            <Text color="secondary">{selectionText} selected</Text>
          </VStack>
          {isOwner ? (
            <HStack gap={2} xstyle={styles.actionRow}>
              <Button
                label="Delete"
                onClick={confirmDeleteSelection}
                size="sm"
                icon={<Icon icon={Trash2} size="sm" />}
                variant="destructive"
              />
            </HStack>
          ) : null}
        </VStack>
      );
    }

    if (selectedEdge && !selectedNode) {
      return (
        <VStack gap={4} padding={4}>
          <TextInput isReadOnly label="Connection ID" value={selectedEdge.id} />
          <TextInput isReadOnly label="Source" value={selectedEdge.source} />
          <TextInput isReadOnly label="Target" value={selectedEdge.target} />

          {isOwner ? (
            <HStack gap={2} xstyle={styles.actionRow}>
              <Button
                label="Delete"
                onClick={confirmDeleteEdge}
                size="sm"
                icon={<Icon icon={Trash2} size="sm" />}
                variant="destructive"
              />
            </HStack>
          ) : null}
        </VStack>
      );
    }

    // Workflow-level properties, which is what nothing being selected means.
    if (!selectedNode) {
      return (
        <VStack gap={4} padding={4}>
          <TextInput
            isDisabled={!isOwner}
            label="Workflow Name"
            onChange={handleUpdateWorkflowName}
            status={
              workflowNameError
                ? { type: "error", message: workflowNameError }
                : undefined
            }
            value={currentWorkflowName}
          />
          <TextInput
            isReadOnly
            label="Workflow ID"
            value={currentWorkflowId || "Not saved"}
          />
          {isOwner ? null : publicWorkflowNotice}
          {isOwner ? (
            <HStack gap={2} xstyle={styles.actionRow}>
              <Button
                label="Clear"
                onClick={confirmClearWorkflow}
                size="sm"
                icon={<Icon icon={Eraser} size="sm" />}
                variant="ghost"
              />
              <Button
                label="Delete"
                onClick={confirmDeleteWorkflow}
                size="sm"
                icon={<Icon icon={Trash2} size="sm" />}
                variant="destructive"
              />
            </HStack>
          ) : null}
        </VStack>
      );
    }

    if (showActionGrid) {
      return (
        <div {...stylex.props(styles.actionGrid)}>
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
      <VStack gap={4} padding={4}>
        {selectedNode.data.type === "group" ? (
          <Text color="secondary">
            Lookups and a Condition in a single-entry, single-exit frame.
            Lookups may run side by side and join at the Condition. True
            continues; False with no outgoing edge ends that path.
          </Text>
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
          <Banner
            description="Choose an action to configure this step."
            status="info"
            title="No action configured"
          />
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
          <VStack
            gap={selectedNode.data.type === "lifecycle" ? 3 : 4}
            padding={selectedNode.data.type === "lifecycle" ? 3 : 0}
            xstyle={
              selectedNode.data.type === "lifecycle"
                ? styles.metadata
                : undefined
            }
          >
            {selectedNode.data.type === "lifecycle" ? (
              <Text color="secondary" type="label">
                Node metadata
              </Text>
            ) : null}

            <TextInput
              isDisabled={isGenerating || !isOwner}
              label="Label"
              onChange={handleUpdateLabel}
              value={selectedNode.data.label}
            />

            <TextInput
              isDisabled={isGenerating || !isOwner}
              label="Description"
              onChange={handleUpdateDescription}
              placeholder="Optional description"
              value={selectedNode.data.description || ""}
            />
          </VStack>
        ) : null}

        {isOwner ? null : publicWorkflowNotice}

        {isOwner && selectedNode.parentId ? (
          <Text color="secondary" type="supporting">
            This step runs with its Group. Select the frame to switch it off.
          </Text>
        ) : null}

        {isOwner ? (
          <HStack gap={2} wrap="wrap" xstyle={styles.actionRow}>
            {showDisabledToggle ? (
              <Button
                label={isSelectionDisabled ? "Disabled" : "Enabled"}
                onClick={handleToggleEnabled}
                size="sm"
                icon={
                  <Icon icon={isSelectionDisabled ? EyeOff : Eye} size="sm" />
                }
                variant="secondary"
              />
            ) : null}
            {canUngroup(selectedNode) ? (
              <Button
                label="Ungroup"
                onClick={() => ungroupSelected(selectedNode.id)}
                size="sm"
                icon={<Icon icon={Ungroup} size="sm" />}
                variant="secondary"
              />
            ) : null}
            {/* A member is deleted by deleting or ungrouping its frame, which
                is what keeps the frame's entry and exit naming a live step. */}
            {refuseDelete([selectedNode]) ? null : (
              <Button
                label="Delete"
                onClick={confirmDeleteNode}
                size="sm"
                icon={<Icon icon={Trash2} size="sm" />}
                variant="destructive"
              />
            )}
          </HStack>
        ) : null}
      </VStack>
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
    <div data-testid="properties-panel" {...stylex.props(styles.panel)}>
      {frame.tabs === "top" ? tabBar : null}

      {validActiveTab === "properties" ? (
        <div {...stylex.props(styles.scrollArea)}>
          {renderPropertiesContent()}
        </div>
      ) : (
        <div {...stylex.props(styles.panel)}>
          <HStack
            gap={2}
            paddingBlock={2}
            paddingInline={4}
            xstyle={styles.runActions}
          >
            <Button
              label="Refresh"
              onClick={handleRefreshRuns}
              size="sm"
              icon={<Icon icon={RefreshCw} size="sm" />}
              variant="secondary"
            />
            <Button
              label="Clear all"
              onClick={confirmDeleteAllRuns}
              size="sm"
              icon={<Icon icon={Eraser} size="sm" />}
              variant="ghost"
            />
          </HStack>
          <div {...stylex.props(styles.runList)}>
            <WorkflowRuns />
          </div>
        </div>
      )}

      {frame.tabs === "bottom" ? tabBar : null}
    </div>
  );
}

const styles = stylex.create({
  panel: {
    display: "flex",
    flex: 1,
    flexDirection: "column",
    minHeight: 0,
  },
  tabBar: {
    flexShrink: 0,
    paddingInline: spacingVars["--spacing-4"],
  },
  topTabBar: {
    borderBottomColor: colorVars["--color-border"],
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    paddingBlock: spacingVars["--spacing-2"],
  },
  bottomTabBar: {
    borderTopColor: colorVars["--color-border"],
    borderTopStyle: "solid",
    borderTopWidth: 1,
    paddingBlock: spacingVars["--spacing-3"],
    paddingBottom: `max(${spacingVars["--spacing-3"]}, env(safe-area-inset-bottom))`,
  },
  scrollArea: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    overscrollBehavior: "contain",
    scrollbarGutter: "stable both-edges",
  },
  actionGrid: {
    paddingInline: spacingVars["--spacing-4"],
    paddingTop: spacingVars["--spacing-4"],
  },
  actionRow: {
    paddingTop: spacingVars["--spacing-4"],
  },
  metadata: {
    backgroundColor: colorVars["--color-neutral"],
    borderColor: colorVars["--color-border"],
    borderRadius: "var(--radius-container)",
    borderStyle: "solid",
    borderWidth: 1,
  },
  runActions: {
    borderBottomColor: colorVars["--color-border"],
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    flexShrink: 0,
  },
  runList: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    overscrollBehavior: "contain",
    padding: spacingVars["--spacing-4"],
    scrollbarGutter: "stable both-edges",
  },
});
