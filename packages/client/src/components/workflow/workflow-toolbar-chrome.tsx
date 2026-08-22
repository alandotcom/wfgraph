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
import { ConfirmOverlay } from "#src/components/overlays/confirm-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { useConfigurationSheet } from "#src/hooks/use-configuration-sheet";
import { useIsMobile } from "#src/hooks/use-mobile";
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
import { cn } from "@wfgraph/shared/utils";

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
      className="relative gap-1.5"
      disabled={disabled || isPublishing}
      onClick={handlePublish}
      size="default"
      title={isPublishing ? "Publishing..." : "Publish workflow"}
      variant="default"
    >
      {isPublishing ? (
        <Loader2 className="size-4 animate-spin" data-icon="inline-start" />
      ) : (
        <Upload className="size-4" data-icon="inline-start" />
      )}
      {/* Same breakpoint the toolbar row uses to go horizontal, so the label
          appears exactly when there is a row wide enough to hold it. */}
      <span className="hidden @xl:inline">
        {isPublishing ? "Publishing" : "Publish"}
      </span>
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
      className="relative"
      disabled={!hasRealNodes || state.isGenerating || state.isSaving}
      onClick={handleSave}
      size="icon"
      title={state.isSaving ? "Saving..." : "Save workflow"}
      variant="outline"
    >
      {state.isSaving ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Save className="size-4" />
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
        disabled={isDisabled}
        onClick={() => actions.handleExecute()}
        size="icon"
        title="Run Workflow"
        variant="outline"
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
      disabled={isDuplicating}
      onClick={onDuplicate}
      size="sm"
      title="Duplicate to your workflows"
      variant="outline"
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
      <ButtonGroup className="flex" orientation="horizontal">
        <Button
          disabled={state.isGenerating}
          onClick={handleAddStep}
          size="icon"
          title="Add Step"
          variant="outline"
        >
          <Plus className="size-4" />
        </Button>
      </ButtonGroup>

      {/* Config and Delete, shown only while the properties rail is absent.
          Gated on the same test the rail uses, not on the toolbar's container
          width: those two disagreed, so a narrow canvas on a wide window showed
          the sheet button while the rail was still mounted, and both edited the
          same node. */}
      <ButtonGroup
        className={cn("flex", isMobile ? "" : "hidden")}
        orientation="horizontal"
      >
        <Button
          onClick={openSheet}
          size="icon"
          title="Configuration"
          variant="outline"
        >
          <Settings2 className="size-4" />
        </Button>
        {hasSelection && (
          <Button
            onClick={handleDeleteConfirm}
            size="icon"
            title="Delete"
            variant="outline"
          >
            <Trash2 className="size-4" />
          </Button>
        )}
      </ButtonGroup>

      <ButtonGroup className="flex" orientation="horizontal">
        <Button
          disabled={!state.canUndo || state.isGenerating}
          onClick={() => state.undo()}
          size="icon"
          title="Undo"
          variant="outline"
        >
          <Undo2 className="size-4" />
        </Button>
        <Button
          disabled={!state.canRedo || state.isGenerating}
          onClick={() => state.redo()}
          size="icon"
          title="Redo"
          variant="outline"
        >
          <Redo2 className="size-4" />
        </Button>
      </ButtonGroup>

      <ButtonGroup className="flex" orientation="horizontal">
        <SaveButton handleSave={actions.handleSave} state={state} />
        <PublishButton
          disabled={publishDisabled}
          handlePublish={actions.handlePublish}
          isPublishing={actions.isPublishing}
        />
      </ButtonGroup>

      <RunButtonGroup actions={actions} state={state} />
      {workflowId && (
        // A radiogroup rather than two buttons: this decides whether the
        // workflow sends real SMS and email, and it previously reported no state
        // at all to a screen reader while distinguishing the two visually by a
        // 3% fill difference.
        <ButtonGroup
          aria-label="Workflow mode"
          className="flex"
          orientation="horizontal"
          role="radiogroup"
        >
          {(["live", "test"] as const).map((mode) => {
            const isSelected = state.workflowMode === mode;
            return (
              <Button
                aria-checked={isSelected}
                className="border"
                disabled={state.isSaving || state.isGenerating}
                key={mode}
                onClick={() => actions.handleSetWorkflowMode(mode)}
                role="radio"
                size="default"
                variant={isSelected ? "default" : "outline"}
              >
                {mode === "live" ? "Live" : "Test"}
              </Button>
            );
          })}
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
        {/* A breadcrumb rather than one dropdown: the way out of the editor used
            to be the first item inside this menu, which is a place nobody looks
            for navigation. The crumb leaves; the trigger beside it still
            switches workflows. */}
        <div className="flex h-9 max-w-[260px] items-center overflow-hidden rounded-md border bg-secondary text-secondary-foreground sm:max-w-none">
          <button
            className="flex h-full shrink-0 cursor-pointer items-center gap-2 px-3 font-medium text-sm transition-all hover:bg-accent dark:hover:bg-accent"
            onClick={() => navigate({ to: "/" })}
            type="button"
          >
            <WorkflowIcon className="size-4 shrink-0" />
            <span className="hidden @xl:inline">Dashboard</span>
          </button>
          <span aria-hidden="true" className="text-muted-foreground/60">
            /
          </span>
          <DropdownMenu
            onOpenChange={(open) => open && actions.loadWorkflows()}
          >
            <DropdownMenuTrigger className="flex h-full min-w-0 cursor-pointer items-center gap-2 px-3 font-medium text-sm transition-all hover:bg-accent dark:hover:bg-accent">
              {/* Named for what it is when there is no id yet: a canvas nobody
                  has saved. It used to read "Workflow Dashboard" here, which
                  named a screen the user was not on. */}
              <p className="truncate font-medium text-sm">
                {state.workflowName || "Untitled workflow"}
              </p>
              <ChevronDown className="size-3 shrink-0 opacity-50" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
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
          <span className="text-muted-foreground text-xs @xl:hidden">
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
