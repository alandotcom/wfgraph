/**
 * Toolbar chrome: the menu, add/undo/save/run controls, and mode toggle.
 * Behaviour hooks live in `workflow-toolbar-handlers`.
 */

import { useNavigate } from "@tanstack/react-router";
import { useReactFlow } from "@xyflow/react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  Check,
  ChevronDown,
  Copy,
  Loader2,
  Play,
  Plus,
  Redo2,
  Save,
  Settings2,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import { nanoid } from "nanoid";
import { useState } from "react";
import { ConfigurationOverlay } from "#src/components/overlays/configuration-overlay";
import { ConfirmOverlay } from "#src/components/overlays/confirm-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { Button } from "#src/components/ui/button";
import { ButtonGroup } from "#src/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#src/components/ui/dropdown-menu";
import { WorkflowIcon } from "#src/components/ui/workflow-icon";
import { CreateWorkflowDialog } from "#src/components/workflow/create-workflow-dialog";
import {
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/components/workflow/workflow-node-dimensions";
import type {
  WorkflowToolbarActions,
  WorkflowToolbarState,
} from "#src/components/workflow/workflow-toolbar-handlers";
import {
  deleteEdgeAtom,
  deleteNodeAtom,
  edgesAtom,
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
    <Button
      className="relative border hover:bg-secondary disabled:opacity-100 dark:hover:bg-secondary disabled:[&>svg]:text-muted-foreground"
      disabled={disabled || isPublishing}
      onClick={handlePublish}
      size="icon"
      title={isPublishing ? "Publishing..." : "Publish workflow"}
      variant="secondary"
    >
      {isPublishing ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Upload className="size-4" />
      )}
    </Button>
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
    <Button
      className="relative border hover:bg-secondary disabled:opacity-100 dark:hover:bg-secondary disabled:[&>svg]:text-muted-foreground"
      disabled={!hasRealNodes || state.isGenerating || state.isSaving}
      onClick={handleSave}
      size="icon"
      title={state.isSaving ? "Saving..." : "Save workflow"}
      variant="secondary"
    >
      {state.isSaving ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Save className="size-4" />
      )}
      {state.hasUnsavedChanges && !state.isSaving && (
        <div className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary" />
      )}
    </Button>
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
    <ButtonGroup className="flex" orientation="horizontal">
      <Button
        className="border hover:bg-secondary disabled:opacity-100 dark:hover:bg-secondary disabled:[&>svg]:text-muted-foreground"
        disabled={isDisabled}
        onClick={() => actions.handleExecute()}
        size="icon"
        title="Run Workflow"
        variant="secondary"
      >
        {state.isExecuting ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Play className="size-4" />
        )}
      </Button>
    </ButtonGroup>
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
      className="h-9 border hover:bg-secondary dark:hover:bg-secondary"
      disabled={isDuplicating}
      onClick={onDuplicate}
      size="sm"
      title="Duplicate to your workflows"
      variant="secondary"
    >
      {isDuplicating ? (
        <Loader2 className="mr-2 size-4 animate-spin" />
      ) : (
        <Copy className="mr-2 size-4" />
      )}
      Duplicate
    </Button>
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
  const { open: openOverlay, push } = useOverlay();
  const [selectedNodeId] = useAtom(selectedNodeAtom);
  const [selectedEdgeId] = useAtom(selectedEdgeAtom);
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const deleteNode = useSetAtom(deleteNodeAtom);
  const deleteEdge = useSetAtom(deleteEdgeAtom);
  const { screenToFlowPosition } = useReactFlow();

  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  const hasSelection = selectedNode || selectedEdge;
  const publishDisabled =
    state.isGenerating ||
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
    const threshold = 20;

    const finalPosition = { ...position };
    let hasOverlap = true;
    let attempts = 0;
    const maxAttempts = 20;

    while (hasOverlap && attempts < maxAttempts) {
      hasOverlap = state.nodes.some((node) => {
        const dx = Math.abs(node.position.x - finalPosition.x);
        const dy = Math.abs(node.position.y - finalPosition.y);
        return dx < threshold && dy < threshold;
      });

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
      {/* Add Step - Mobile Vertical */}
      <ButtonGroup className="flex lg:hidden" orientation="vertical">
        <Button
          className="border hover:bg-secondary disabled:opacity-100 dark:hover:bg-secondary disabled:[&>svg]:text-muted-foreground"
          disabled={state.isGenerating}
          onClick={handleAddStep}
          size="icon"
          title="Add Step"
          variant="secondary"
        >
          <Plus className="size-4" />
        </Button>
      </ButtonGroup>

      {/* Properties - Mobile Vertical (always visible) */}
      <ButtonGroup className="flex lg:hidden" orientation="vertical">
        <Button
          className="border hover:bg-secondary dark:hover:bg-secondary"
          onClick={() => openOverlay(ConfigurationOverlay, {})}
          size="icon"
          title="Configuration"
          variant="secondary"
        >
          <Settings2 className="size-4" />
        </Button>
        {/* Delete - Show when node or edge is selected */}
        {hasSelection && (
          <Button
            className="border hover:bg-secondary dark:hover:bg-secondary"
            onClick={handleDeleteConfirm}
            size="icon"
            title="Delete"
            variant="secondary"
          >
            <Trash2 className="size-4" />
          </Button>
        )}
      </ButtonGroup>

      {/* Add Step - Desktop Horizontal */}
      <ButtonGroup className="hidden lg:flex" orientation="horizontal">
        <Button
          className="border hover:bg-secondary disabled:opacity-100 dark:hover:bg-secondary disabled:[&>svg]:text-muted-foreground"
          disabled={state.isGenerating}
          onClick={handleAddStep}
          size="icon"
          title="Add Step"
          variant="secondary"
        >
          <Plus className="size-4" />
        </Button>
      </ButtonGroup>

      {/* Undo/Redo - Mobile Vertical */}
      <ButtonGroup className="flex lg:hidden" orientation="vertical">
        <Button
          className="border hover:bg-secondary disabled:opacity-100 dark:hover:bg-secondary disabled:[&>svg]:text-muted-foreground"
          disabled={!state.canUndo || state.isGenerating}
          onClick={() => state.undo()}
          size="icon"
          title="Undo"
          variant="secondary"
        >
          <Undo2 className="size-4" />
        </Button>
        <Button
          className="border hover:bg-secondary disabled:opacity-100 dark:hover:bg-secondary disabled:[&>svg]:text-muted-foreground"
          disabled={!state.canRedo || state.isGenerating}
          onClick={() => state.redo()}
          size="icon"
          title="Redo"
          variant="secondary"
        >
          <Redo2 className="size-4" />
        </Button>
      </ButtonGroup>

      {/* Undo/Redo - Desktop Horizontal */}
      <ButtonGroup className="hidden lg:flex" orientation="horizontal">
        <Button
          className="border hover:bg-secondary disabled:opacity-100 dark:hover:bg-secondary disabled:[&>svg]:text-muted-foreground"
          disabled={!state.canUndo || state.isGenerating}
          onClick={() => state.undo()}
          size="icon"
          title="Undo"
          variant="secondary"
        >
          <Undo2 className="size-4" />
        </Button>
        <Button
          className="border hover:bg-secondary disabled:opacity-100 dark:hover:bg-secondary disabled:[&>svg]:text-muted-foreground"
          disabled={!state.canRedo || state.isGenerating}
          onClick={() => state.redo()}
          size="icon"
          title="Redo"
          variant="secondary"
        >
          <Redo2 className="size-4" />
        </Button>
      </ButtonGroup>

      {/* Save - Mobile Vertical */}
      <ButtonGroup className="flex lg:hidden" orientation="vertical">
        <SaveButton handleSave={actions.handleSave} state={state} />
        <PublishButton
          disabled={publishDisabled}
          handlePublish={actions.handlePublish}
          isPublishing={actions.isPublishing}
        />
      </ButtonGroup>

      {/* Save - Desktop Horizontal */}
      <ButtonGroup className="hidden lg:flex" orientation="horizontal">
        <SaveButton handleSave={actions.handleSave} state={state} />
        <PublishButton
          disabled={publishDisabled}
          handlePublish={actions.handlePublish}
          isPublishing={actions.isPublishing}
        />
      </ButtonGroup>

      <RunButtonGroup actions={actions} state={state} />
      {workflowId && (
        <ButtonGroup className="flex" orientation="horizontal">
          <Button
            className="border"
            disabled={state.isSaving || state.isGenerating}
            onClick={() => actions.handleSetWorkflowMode("live")}
            size="sm"
            variant={state.workflowMode === "live" ? "secondary" : "outline"}
          >
            Live
          </Button>
          <Button
            className="border"
            disabled={state.isSaving || state.isGenerating}
            onClick={() => actions.handleSetWorkflowMode("test")}
            size="sm"
            variant={state.workflowMode === "test" ? "secondary" : "outline"}
          >
            Test
          </Button>
        </ButtonGroup>
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
      <div className="flex flex-col gap-1">
        <div className="flex h-9 max-w-[160px] items-center overflow-hidden rounded-md border bg-secondary text-secondary-foreground sm:max-w-none">
          <DropdownMenu
            onOpenChange={(open) => open && actions.loadWorkflows()}
          >
            <DropdownMenuTrigger className="flex h-full cursor-pointer items-center gap-2 px-3 font-medium text-sm transition-all hover:bg-secondary dark:hover:bg-secondary">
              <WorkflowIcon className="size-4 shrink-0" />
              <p className="truncate font-medium text-sm">
                {workflowId ? (
                  state.workflowName
                ) : (
                  <>
                    <span className="sm:hidden">Dashboard</span>
                    <span className="hidden sm:inline">Workflow Dashboard</span>
                  </>
                )}
              </p>
              <ChevronDown className="size-3 shrink-0 opacity-50" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuItem
                className="flex items-center justify-between"
                onClick={() => navigate({ to: "/" })}
              >
                Dashboard {!workflowId && <Check className="size-4 shrink-0" />}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="flex items-center gap-2"
                onClick={() => {
                  setCreateDialogSession((session) => session + 1);
                  setIsCreateDialogOpen(true);
                }}
              >
                <Plus className="size-4" />
                New Workflow...
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {state.allWorkflows.length === 0 ? (
                <DropdownMenuItem disabled>No workflows found</DropdownMenuItem>
              ) : (
                state.allWorkflows
                  .filter((w) => w.name !== "__current__")
                  .map((workflow) => (
                    <DropdownMenuItem
                      className="flex items-center justify-between"
                      key={workflow.id}
                      onClick={() =>
                        navigate({
                          to: "/workflows/$workflowId",
                          params: { workflowId: workflow.id },
                        })
                      }
                    >
                      <span className="truncate">{workflow.name}</span>
                      {workflow.id === state.currentWorkflowId && (
                        <Check className="size-4 shrink-0" />
                      )}
                    </DropdownMenuItem>
                  ))
              )}
              {workflowId && state.isOwner && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="flex items-center gap-2"
                    disabled={actions.isDuplicating}
                    onClick={actions.handleDuplicate}
                  >
                    {actions.isDuplicating ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Copy className="size-4" />
                    )}
                    Duplicate
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="flex items-center gap-2 text-destructive focus:text-destructive"
                    onClick={actions.handleDeleteWorkflow}
                  >
                    <Trash2 className="size-4" />
                    Delete Workflow
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {workflowId && !state.isOwner && (
          <span className="text-muted-foreground text-xs uppercase lg:hidden">
            Read-only
          </span>
        )}
      </div>
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
