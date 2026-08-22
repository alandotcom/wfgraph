/**
 * Toolbar chrome: the menu, add/undo/save/run controls, and mode toggle.
 * Behaviour hooks live in `workflow-toolbar-handlers`.
 */

import { useNavigate } from "@tanstack/react-router";
import { useReactFlow } from "@xyflow/react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  Copy,
  Play,
  Plus,
  Redo2,
  Save,
  Settings2,
  Trash2,
  Undo2,
  Upload,
  Workflow as WorkflowGlyph,
} from "lucide-react";
import { nanoid } from "nanoid";
import { useState } from "react";
import { ConfirmOverlay } from "#src/components/overlays/confirm-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { useConfigurationSheet } from "#src/hooks/use-configuration-sheet";
import { useIsMobile } from "#src/hooks/use-mobile";
import { Button } from "@astryxdesign/core/Button";
import { ButtonGroup } from "@astryxdesign/core/ButtonGroup";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { CreateWorkflowDialog } from "#src/components/workflow/create-workflow-dialog";
import {
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/lib/workflow-node-dimensions";
import type {
  WorkflowToolbarActions,
  WorkflowToolbarState,
} from "#src/components/workflow/workflow-toolbar-handlers";
import {
  deleteEdgeAtom,
  deleteNodeAtom,
  edgesAtom,
  canvasEditingLockedAtom,
  nodesAtom,
  selectedEdgeAtom,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";

function PublishButton({
  isPublishing,
  disabled,
  handlePublish,
}: {
  isPublishing: boolean;
  disabled: boolean;
  handlePublish: () => void;
}) {
  return (
    // Publish is the one control here that changes what real customers receive,
    // and it used to be the fifth identical 36px square in a row of six. It gets
    // the primary fill and a written label so it stops reading like Redo.
    <Button
      icon={<Icon icon={Upload} size="sm" />}
      isDisabled={disabled}
      isLoading={isPublishing}
      label={isPublishing ? "Publishing" : "Publish"}
      onClick={handlePublish}
      tooltip="Publish workflow"
      variant="primary"
    />
  );
}

function SaveButton({
  state,
  handleSave,
}: {
  state: WorkflowToolbarState;
  handleSave: () => Promise<void>;
}) {
  const hasRealNodes = state.nodes.some((node) => node.type !== "add");

  return (
    <IconButton
      icon={<Icon icon={Save} size="sm" />}
      isDisabled={!hasRealNodes || state.isGenerating}
      isLoading={state.isSaving}
      label="Save workflow"
      onClick={handleSave}
      tooltip={state.isSaving ? "Saving workflow" : "Save workflow"}
      variant="secondary"
    />
  );
}

function RunButtonGroup({
  state,
  actions,
}: {
  state: WorkflowToolbarState;
  actions: WorkflowToolbarActions;
}) {
  const isDisabled =
    state.isExecuting ||
    state.nodes.length === 0 ||
    state.isGenerating ||
    !state.currentWorkflowId;

  return (
    <IconButton
      icon={<Icon icon={Play} size="sm" />}
      isDisabled={isDisabled}
      isLoading={state.isExecuting}
      label="Run workflow"
      onClick={() => actions.handleExecute()}
      tooltip="Run workflow"
      variant="secondary"
    />
  );
}

export function DuplicateButton({
  isDuplicating,
  onDuplicate,
}: {
  isDuplicating: boolean;
  onDuplicate: () => void;
}) {
  return (
    <Button
      icon={<Icon icon={Copy} size="sm" />}
      isLoading={isDuplicating}
      label="Duplicate"
      onClick={onDuplicate}
      tooltip="Duplicate to your workflows"
      variant="secondary"
    />
  );
}

export function ToolbarActions({
  workflowId,
  state,
  actions,
}: {
  workflowId?: string;
  state: WorkflowToolbarState;
  actions: WorkflowToolbarActions;
}) {
  const { push } = useOverlay();
  const { openSheet } = useConfigurationSheet();
  const [selectedNodeId] = useAtom(selectedNodeAtom);
  const [selectedEdgeId] = useAtom(selectedEdgeAtom);
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const deleteNode = useSetAtom(deleteNodeAtom);
  const deleteEdge = useSetAtom(deleteEdgeAtom);
  const { screenToFlowPosition } = useReactFlow();
  const isMobile = useIsMobile();
  const editingLocked = useAtomValue(canvasEditingLockedAtom);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  const hasSelection = selectedNode || selectedEdge;
  // A run overlay pins the canvas to a past run's graph; Publish sends the
  // draft underneath it, which the user cannot see while it's pinned (#39).
  // Every other graph write already refuses under the same conditions, so
  // Publish reads the same atom the canvas does rather than restating them.
  // Saving is Publish's own concern: the canvas stays editable during a save.
  const publishDisabled =
    editingLocked ||
    state.isSaving ||
    !state.nodes.some((node) => node.type !== "add");

  // For non-owners viewing public workflows, don't show toolbar actions.
  if (workflowId && !state.isOwner) {
    return null;
  }

  const handleDeleteConfirm = () => {
    const isNode = Boolean(selectedNodeId);
    const itemType = isNode ? "Node" : "Connection";

    push(ConfirmOverlay, {
      title: `Delete ${itemType}`,
      message: `Are you sure you want to delete this ${itemType.toLowerCase()}? This action cannot be undone.`,
      confirmLabel: "Delete",
      confirmVariant: "destructive" as const,
      onConfirm: () => {
        if (selectedNodeId) {
          deleteNode(selectedNodeId);
        } else if (selectedEdgeId) {
          deleteEdge(selectedEdgeId);
        }
      },
    });
  };

  const handleAddStep = () => {
    const flowWrapper = document.querySelector(".react-flow");
    if (!flowWrapper) {
      return;
    }

    const rect = flowWrapper.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const position = screenToFlowPosition({ x: centerX, y: centerY });

    position.x -= WORKFLOW_NODE_WIDTH / 2;
    position.y -= WORKFLOW_NODE_HEIGHT / 2;

    const offset = 20;

    const finalPosition = { ...position };
    let hasOverlap = true;
    let attempts = 0;
    const maxAttempts = 20;

    while (hasOverlap && attempts < maxAttempts) {
      // Full rectangles, not top-left corners. Comparing corners against a 20px
      // threshold meant a node offset by 21px counted as clear, so a new step
      // landed on top of a neighbour it overlapped by nearly its whole width.
      hasOverlap = state.nodes.some(
        (node) =>
          Math.abs(node.position.x - finalPosition.x) < WORKFLOW_NODE_WIDTH &&
          Math.abs(node.position.y - finalPosition.y) < WORKFLOW_NODE_HEIGHT
      );

      if (hasOverlap) {
        finalPosition.x += offset;
        finalPosition.y += offset;
        attempts += 1;
      }
    }

    const newNode: WorkflowNode = {
      id: nanoid(),
      type: "action",
      position: finalPosition,
      data: {
        label: "",
        description: "",
        type: "action",
        config: {},
        status: "idle",
      },
    };

    state.addNode(newNode);
    state.setSelectedNodeId(newNode.id);
    state.setActiveTab("properties");
  };

  return (
    <>
      {/* One horizontal set at every width. There used to be a vertical
          duplicate of each group for narrow screens, which stacked the toolbar
          into a 368px column over the graph and reversed the control order
          against desktop, so muscle memory broke at the breakpoint. The row
          scrolls instead. */}
      <IconButton
        icon={<Icon icon={Plus} size="sm" />}
        isDisabled={state.isGenerating}
        label="Add step"
        onClick={handleAddStep}
        tooltip="Add step"
        variant="secondary"
      />

      {/* Config and Delete, shown only while the properties rail is absent.
          Gated on the same test the rail uses, not on the toolbar's container
          width: those two disagreed, so a narrow canvas on a wide window showed
          the sheet button while the rail was still mounted, and both edited the
          same node. */}
      {isMobile ? (
        <ButtonGroup label="Mobile editor actions" orientation="horizontal">
          <IconButton
            icon={<Icon icon={Settings2} size="sm" />}
            label="Configuration"
            onClick={openSheet}
            tooltip="Configuration"
            variant="secondary"
          />
          {hasSelection ? (
            <IconButton
              icon={<Icon icon={Trash2} size="sm" />}
              label="Delete selection"
              onClick={handleDeleteConfirm}
              tooltip="Delete selection"
              variant="secondary"
            />
          ) : null}
        </ButtonGroup>
      ) : null}

      <ButtonGroup label="History actions" orientation="horizontal">
        <IconButton
          icon={<Icon icon={Undo2} size="sm" />}
          isDisabled={!state.canUndo || state.isGenerating}
          label="Undo"
          onClick={() => state.undo()}
          tooltip="Undo"
          variant="secondary"
        />
        <IconButton
          icon={<Icon icon={Redo2} size="sm" />}
          isDisabled={!state.canRedo || state.isGenerating}
          label="Redo"
          onClick={() => state.redo()}
          tooltip="Redo"
          variant="secondary"
        />
      </ButtonGroup>

      <SaveButton handleSave={actions.handleSave} state={state} />
      <PublishButton
        disabled={publishDisabled}
        handlePublish={actions.handlePublish}
        isPublishing={actions.isPublishing}
      />

      <RunButtonGroup actions={actions} state={state} />
      {workflowId && (
        // A radiogroup rather than two buttons: this decides whether the
        // workflow sends real SMS and email, and it previously reported no state
        // at all to a screen reader while distinguishing the two visually by a
        // 3% fill difference.
        <SegmentedControl
          isDisabled={state.isSaving || state.isGenerating}
          label="Workflow mode"
          onChange={(mode) => {
            if (mode === "live" || mode === "test") {
              void actions.handleSetWorkflowMode(mode);
            }
          }}
          value={state.workflowMode}
        >
          <SegmentedControlItem label="Live" value="live" />
          <SegmentedControlItem label="Test" value="test" />
        </SegmentedControl>
      )}
    </>
  );
}

export function WorkflowMenuComponent({
  workflowId,
  state,
  actions,
}: {
  workflowId?: string;
  state: WorkflowToolbarState;
  actions: WorkflowToolbarActions;
}) {
  const navigate = useNavigate();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  // Bumped on every open so the dialog remounts and re-suggests a name. It stays
  // mounted while closing, because that is what its exit animation needs.
  const [createDialogSession, setCreateDialogSession] = useState(0);

  return (
    <>
      <VStack gap={1}>
        <HStack gap={1}>
          <Button
            icon={<Icon icon={WorkflowGlyph} size="sm" />}
            label="Dashboard"
            onClick={() => navigate({ to: "/" })}
            variant="secondary"
          />
          <DropdownMenu
            button={{
              label: state.workflowName || "Untitled workflow",
              variant: "secondary",
              width: 220,
            }}
            items={[
              {
                icon: Plus,
                label: "New workflow...",
                onClick: () => {
                  setCreateDialogSession((session) => session + 1);
                  setIsCreateDialogOpen(true);
                },
              },
              { type: "divider" },
              ...(state.allWorkflows.length === 0
                ? [{ label: "No workflows found", isDisabled: true }]
                : state.allWorkflows
                    .filter((workflow) => workflow.name !== "__current__")
                    .map((workflow) => ({
                      endContent:
                        workflow.id === state.currentWorkflowId ? (
                          <Icon color="accent" icon="check" size="sm" />
                        ) : undefined,
                      id: workflow.id,
                      label: workflow.name,
                      onClick: () =>
                        navigate({
                          to: "/workflows/$workflowId",
                          params: { workflowId: workflow.id },
                        }),
                    }))),
              ...(workflowId && state.isOwner
                ? [
                    { type: "divider" as const },
                    {
                      icon: Copy,
                      isDisabled: actions.isDuplicating,
                      label: "Duplicate",
                      onClick: actions.handleDuplicate,
                    },
                    {
                      icon: Trash2,
                      label: "Delete workflow",
                      onClick: actions.handleDeleteWorkflow,
                      variant: "destructive" as const,
                    },
                  ]
                : []),
            ]}
            menuWidth={256}
            onClick={actions.loadWorkflows}
          />
        </HStack>
        {workflowId && !state.isOwner ? (
          <Text color="secondary" type="supporting">
            Read-only
          </Text>
        ) : null}
      </VStack>
      <CreateWorkflowDialog
        key={createDialogSession}
        existingWorkflowNames={state.allWorkflows.map(
          (workflow) => workflow.name
        )}
        onCreated={(createdWorkflowId) =>
          navigate({
            to: "/workflows/$workflowId",
            params: { workflowId: createdWorkflowId },
          })
        }
        onOpenChange={setIsCreateDialogOpen}
        open={isCreateDialogOpen}
      />
    </>
  );
}
