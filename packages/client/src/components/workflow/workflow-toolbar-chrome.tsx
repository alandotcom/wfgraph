/**
 * The menu bar's controls: the dashboard link, the workflow menu, the Actions
 * menu, the palette's trigger and Publish. Behaviour hooks live in
 * `workflow-toolbar-handlers`.
 *
 * Everything here sits in a bar of fixed height above the canvas, so nothing
 * may wrap or grow with its content: a taller bar is a shorter graph, and React
 * Flow reacts to every pixel of it. A long workflow name truncates.
 */

import { Link, useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  ArrowLeftRight,
  Check,
  ChevronDown,
  Copy,
  Eraser,
  Loader2,
  Pencil,
  Play,
  Plus,
  Redo2,
  RefreshCcw,
  Search,
  Settings2,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmOverlay } from "#src/components/overlays/confirm-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { useConfigurationSheet } from "#src/hooks/use-configuration-sheet";
import { useIsMobile } from "#src/hooks/use-mobile";
import { Button, buttonVariants } from "#src/components/ui/button";
import { ButtonGroup } from "#src/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "#src/components/ui/dropdown-menu";
import { WorkflowIcon } from "#src/components/ui/workflow-icon";
import { CommandPalette } from "#src/components/workflow/command-palette";
import { CreateWorkflowDialog } from "#src/components/workflow/create-workflow-dialog";
import { RenameWorkflowDialog } from "#src/components/workflow/rename-workflow-dialog";
import { useReflowLayout } from "#src/components/workflow/use-reflow-layout";
import {
  currentPlatform,
  editorShortcutLabels,
  isApplePlatform,
} from "#src/lib/shortcut-label";
import type {
  WorkflowToolbarActions,
  WorkflowToolbarState,
} from "#src/components/workflow/workflow-toolbar-handlers";
import {
  commandPaletteRefusalAtom,
  openCommandPaletteAtom,
} from "#src/lib/command-palette-store";
import {
  deleteEdgeAtom,
  deleteNodeAtom,
  edgesAtom,
  canvasEditingLockedAtom,
  nodesAtom,
  selectedEdgeAtom,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-store";
import { cn } from "@wfgraph/shared/utils";

/**
 * Put the workflow's id on the clipboard.
 *
 * The write can be refused outright -- an insecure origin, or a browser that
 * withholds the permission -- so the failure is reported rather than swallowed:
 * a menu item that looks like it worked and did not is worse than one that says
 * so.
 */
async function copyWorkflowId(workflowId: string) {
  try {
    await navigator.clipboard.writeText(workflowId);
    toast.success("Workflow ID copied");
  } catch {
    toast.error("Could not copy the workflow ID");
  }
}

/** The height every control in the bar shares: 28px inside a 44px row. */
const BAR_CONTROL_SIZE = "default" as const;

/** The way out of the editor, kept out of the workflow menu on purpose: it used
 *  to be the first item inside that dropdown, which is a place nobody looks for
 *  navigation. */
export function DashboardLink() {
  return (
    // A router link wearing the button's styles rather than a `Button` handed a
    // link to render: Base UI's button either logs that its element is not a
    // <button>, or takes `nativeButton={false}` and announces this link as a
    // button. It stays a link, which is what makes middle-click and the context
    // menu open the dashboard in a tab.
    <Link
      aria-label="Dashboard"
      className={buttonVariants({ size: "icon", variant: "secondary" })}
      title="Dashboard"
      to="/"
    >
      <WorkflowIcon className="size-3.5" />
    </Link>
  );
}

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
    // the primary fill and a written label at every width.
    <Button
      disabled={disabled || isPublishing}
      onClick={handlePublish}
      size={BAR_CONTROL_SIZE}
      variant="default"
    >
      {isPublishing ? (
        <Loader2 className="size-3.5 animate-spin" data-icon="inline-start" />
      ) : (
        <Upload className="size-3.5" data-icon="inline-start" />
      )}
      {isPublishing ? "Publishing" : "Publish"}
    </Button>
  );
}

/**
 * The palette's trigger: a search box in name and shape, a button in fact.
 *
 * It shrinks, and it appears only once the row has the width for it. Everything
 * else in the bar is fixed, so this is the one thing that can give: a fixed
 * 256px here is what used to push Publish and the settings menu off the end of
 * a row whose scrollbar is hidden.
 *
 * Disabled rather than hidden whenever the palette would refuse to open, with
 * the reason on the control: a button that vanishes teaches nothing about why,
 * and this one at least says it under the pointer.
 */
function CommandPaletteTrigger() {
  const openPalette = useSetAtom(openCommandPaletteAtom);
  const refusal = useAtomValue(commandPaletteRefusalAtom);
  const onApple = isApplePlatform(currentPlatform());
  const shortcuts = editorShortcutLabels(onApple);

  return (
    <Button
      // One chord, the one this keyboard has. The visible hint already picked a
      // platform, and naming both here would have the button announce a key the
      // reader does not have.
      aria-keyshortcuts={onApple ? "Meta+K" : "Control+K"}
      className="hidden w-64 min-w-0 shrink justify-start font-normal text-muted-foreground @3xl:inline-flex"
      disabled={refusal !== null}
      onClick={() => openPalette({ id: "root" })}
      size={BAR_CONTROL_SIZE}
      title={refusal ?? undefined}
      variant="outline"
    >
      <Search className="size-3.5" data-icon="inline-start" />
      <span className="truncate">Search or add a step</span>
      {/* Hidden from the name: `aria-keyshortcuts` above already says this, and
          in the accessible name it read as part of what the button is called. */}
      <kbd
        aria-hidden="true"
        className="ml-auto shrink-0 rounded-sm bg-muted-foreground/10 px-1 font-sans text-[0.625rem]"
      >
        {shortcuts.palette}
      </kbd>
    </Button>
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
      size={BAR_CONTROL_SIZE}
      title="Duplicate to your workflows"
      variant="outline"
    >
      {isDuplicating ? (
        <Loader2 className="size-3.5 animate-spin" data-icon="inline-start" />
      ) : (
        <Copy className="size-3.5" data-icon="inline-start" />
      )}
      Duplicate
    </Button>
  );
}

/**
 * Everything the builder can do to the open workflow, as one menu.
 *
 * Each item states its own name, which the six grey icon squares this replaced
 * could only do on hover. Only shortcuts that are bound appear beside an item.
 */
function ActionsMenu({
  workflowId,
  state,
  actions,
  onAddStep,
}: {
  workflowId?: string;
  state: WorkflowToolbarState;
  actions: WorkflowToolbarActions;
  onAddStep: () => void;
}) {
  const editingLocked = useAtomValue(canvasEditingLockedAtom);
  const { canReflow, reflow } = useReflowLayout();
  // Every handler behind these takes either modifier, so the label is the only
  // thing that has to know which key this keyboard has.
  const shortcuts = editorShortcutLabels(isApplePlatform(currentPlatform()));

  const runDisabled =
    state.isExecuting ||
    state.nodes.length === 0 ||
    state.isGenerating ||
    !state.currentWorkflowId;
  // One item rather than a two-state control: the status strip already says
  // which mode the workflow is in, so a radiogroup here would say it twice.
  const otherMode = state.workflowMode === "live" ? "test" : "live";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button size={BAR_CONTROL_SIZE} variant="ghost" />}
      >
        Actions
        <ChevronDown className="size-3 opacity-50" data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {/* Every graph write is gated on the same atom the canvas reads, so a
            run pinned to the canvas refuses these the way it refuses a drag.
            The buttons this replaced checked only generation, which left the
            menu editing a draft nobody could see. */}
        <DropdownMenuItem disabled={editingLocked} onClick={onAddStep}>
          <Plus />
          Add step
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={runDisabled}
          onClick={() => void actions.handleExecute()}
        >
          <Play />
          Run workflow
          <DropdownMenuShortcut>{shortcuts.run}</DropdownMenuShortcut>
        </DropdownMenuItem>
        {workflowId && (
          <DropdownMenuItem
            disabled={state.isSaving || state.isGenerating}
            onClick={() => void actions.handleSetWorkflowMode(otherMode)}
          >
            <ArrowLeftRight />
            Switch to {otherMode === "live" ? "Live" : "Test"} mode
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!state.canUndo || editingLocked}
          onClick={() => state.undo()}
        >
          <Undo2 />
          Undo
          <DropdownMenuShortcut>{shortcuts.undo}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!state.canRedo || editingLocked}
          onClick={() => state.redo()}
        >
          <Redo2 />
          Redo
          <DropdownMenuShortcut>{shortcuts.redo}</DropdownMenuShortcut>
        </DropdownMenuItem>
        {/* The same pass as the reflow control at the canvas's bottom left. */}
        <DropdownMenuItem disabled={!canReflow} onClick={reflow}>
          <RefreshCcw />
          Tidy layout
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
  const openPalette = useSetAtom(openCommandPaletteAtom);
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

  // Adding a step is the palette's own job, so the menu item opens it on the
  // node-type page rather than dropping a node with no action on it and leaving
  // the picker to the config panel. Placement is the palette's too: it lands in
  // the middle of the canvas, moved clear of whatever is already there.
  const handleAddStep = () => {
    openPalette({ id: "add-step" });
  };

  return (
    <>
      <ActionsMenu
        actions={actions}
        onAddStep={handleAddStep}
        state={state}
        workflowId={workflowId}
      />

      <CommandPaletteTrigger />
      <CommandPalette actions={actions} state={state} />

      <PublishButton
        disabled={publishDisabled}
        handlePublish={actions.handlePublish}
        isPublishing={actions.isPublishing}
      />

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
    </>
  );
}

/**
 * The workflow's own menu: what can be done to this workflow, which workflow is
 * open, and its id.
 *
 * Rename, Clear and Delete are here because the properties panel that used to
 * hold them shows an empty state whenever nothing is selected.
 */
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
  const editingLocked = useAtomValue(canvasEditingLockedAtom);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false);
  // Bumped on every open so the dialog remounts and re-reads what it starts
  // from. Both stay mounted while closing, because that is what their exit
  // animation needs.
  const [createDialogSession, setCreateDialogSession] = useState(0);
  const [renameDialogSession, setRenameDialogSession] = useState(0);

  // A workflow nobody has saved yet has nothing to rename, duplicate or delete,
  // and a workflow someone else owns is not this user's to change.
  const canEditWorkflow = Boolean(workflowId) && state.isOwner;
  const currentWorkflowId = state.currentWorkflowId;
  // The names the server would refuse, which is every workflow's but this one's.
  const otherWorkflowNames = state.allWorkflows
    .filter((workflow) => workflow.id !== currentWorkflowId)
    .map((workflow) => workflow.name);

  return (
    <>
      {/* The switcher dropdown opening is a good moment to re-read the list. */}
      <DropdownMenu onOpenChange={(open) => open && actions.loadWorkflows()}>
        <DropdownMenuTrigger
          render={
            <Button
              className="min-w-0 max-w-56 shrink"
              size={BAR_CONTROL_SIZE}
              variant="ghost"
            />
          }
          // The name truncates, and two workflows can share a long prefix.
          title={state.workflowName || undefined}
        >
          {/* Named for what it is when there is no id yet: a canvas nobody has
              saved. It used to read "Workflow Dashboard" here, which named a
              screen the user was not on. */}
          <span className="truncate">
            {state.workflowName || "Untitled workflow"}
          </span>
          <ChevronDown className="size-3 opacity-50" data-icon="inline-end" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {canEditWorkflow && (
            <>
              <DropdownMenuItem
                onClick={() => {
                  setRenameDialogSession((session) => session + 1);
                  setIsRenameDialogOpen(true);
                }}
              >
                <Pencil />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={actions.isDuplicating}
                onClick={actions.handleDuplicate}
              >
                {actions.isDuplicating ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Copy />
                )}
                Duplicate workflow
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}

          {/* The label belongs to a group: Base UI reads its context to name the
              group, and a loose one throws. */}
          <DropdownMenuGroup>
            <DropdownMenuLabel>Workflows</DropdownMenuLabel>
            {state.allWorkflows.length === 0 ? (
              <DropdownMenuItem disabled>No workflows found</DropdownMenuItem>
            ) : (
              state.allWorkflows
                .filter((w) => w.name !== "__current__")
                .map((workflow) => (
                  <DropdownMenuItem
                    className="justify-between"
                    key={workflow.id}
                    onClick={() =>
                      navigate({
                        to: "/workflows/$workflowId",
                        params: { workflowId: workflow.id },
                      })
                    }
                  >
                    <span className="truncate">{workflow.name}</span>
                    {workflow.id === currentWorkflowId && (
                      <Check className="size-3.5 shrink-0" />
                    )}
                  </DropdownMenuItem>
                ))
            )}
            <DropdownMenuItem
              onClick={() => {
                setCreateDialogSession((session) => session + 1);
                setIsCreateDialogOpen(true);
              }}
            >
              <Plus />
              New workflow
            </DropdownMenuItem>
          </DropdownMenuGroup>

          {/* Clear empties the graph and keeps the workflow; Delete takes the
              workflow with it. Both were on the properties panel until that
              panel got an empty state, and this menu is where the rest of its
              workflow-level controls went.

              Clear asks only for ownership, as the panel's button did: a draft
              nobody has saved yet has a graph to empty and no id, so gating it
              on `canEditWorkflow` would leave the one canvas most likely to
              need clearing unable to. It reads the same lock every graph write
              in the Actions menu does, because `clearWorkflowAtom` returns
              early under a pinned run and a menu item that only looks enabled
              spends a destructive confirmation on nothing. */}
          {state.isOwner && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={editingLocked}
                onClick={actions.handleClearWorkflow}
              >
                <Eraser />
                Clear workflow
              </DropdownMenuItem>
            </>
          )}

          {canEditWorkflow && (
            <DropdownMenuItem
              onClick={actions.handleDeleteWorkflow}
              variant="destructive"
            >
              <Trash2 />
              Delete workflow
            </DropdownMenuItem>
          )}

          {currentWorkflowId && (
            <>
              <DropdownMenuSeparator />
              {/* The id is what a support conversation asks for, and it is the
                  last thing the panel held that had nowhere else to go. It is a
                  menu item that copies rather than a line of text: `role="menu"`
                  holds items, groups and separators, and a screen reader skips
                  anything else in there entirely. */}
              <DropdownMenuGroup>
                <DropdownMenuLabel>Workflow ID</DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() => void copyWorkflowId(currentWorkflowId)}
                >
                  <Copy />
                  <span className="truncate font-mono">
                    {currentWorkflowId}
                  </span>
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateWorkflowDialog
        key={`create-${createDialogSession}`}
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
      <RenameWorkflowDialog
        key={`rename-${renameDialogSession}`}
        currentName={state.workflowName}
        otherWorkflowNames={otherWorkflowNames}
        onOpenChange={setIsRenameDialogOpen}
        open={isRenameDialogOpen}
      />
    </>
  );
}
