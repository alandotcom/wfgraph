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
import { useReactFlow } from "@xyflow/react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  Check,
  ChevronDown,
  ClipboardPaste,
  Copy,
  CopyPlus,
  CircleDot,
  Eraser,
  Loader2,
  Maximize2,
  Pencil,
  Plus,
  Search,
  Settings2,
  Group as GroupIcon,
  Trash2,
  Upload,
} from "lucide-react";
import { Fragment, useState } from "react";
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "#src/components/ui/dropdown-menu";
import { WorkflowIcon } from "#src/components/ui/workflow-icon";
import { CommandPalette } from "#src/components/workflow/command-palette";
import { PublishReviewDialog } from "#src/components/workflow/publish-review-dialog";
import { CreateWorkflowDialog } from "#src/components/workflow/create-workflow-dialog";
import { RenameWorkflowDialog } from "#src/components/workflow/rename-workflow-dialog";
import { useReflowLayout } from "#src/components/workflow/use-reflow-layout";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import {
  currentPlatform,
  editorShortcutLabels,
  isApplePlatform,
} from "#src/lib/shortcut-label";
import {
  WorkflowCommandIcon,
  workflowCommands,
} from "#src/lib/workflow-commands";
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
  copySelectionAtom,
  duplicateSelectionAtom,
  edgesAtom,
  canvasEditingLockedAtom,
  groupSelectionAtom,
  hasCopiedSelectionAtom,
  nodesAtom,
  selectedEdgeAtom,
  selectedNodeAtom,
  pasteCopiedSelectionAtom,
} from "#src/lib/workflow-graph-store";
import { cn } from "@wfgraph/shared/utils";
import { analyzeGroupableSelection } from "@wfgraph/shared/graph/node-group";

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
  proposedVersion,
}: {
  isPublishing: boolean;
  disabled: boolean;
  handlePublish: () => void;
  proposedVersion?: number;
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
      {isPublishing
        ? "Publishing"
        : proposedVersion
          ? `Publish v${proposedVersion}`
          : "Publish"}
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
export function CommandPaletteTrigger() {
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
      className="hidden w-80 min-w-80 justify-start font-normal text-muted-foreground min-[70rem]:inline-flex"
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

/** The execution mode stays in the toolbar because it applies before and after publication. */
export function WorkflowModeMenu({
  actions,
  state,
}: {
  actions: WorkflowToolbarActions;
  state: WorkflowToolbarState;
}) {
  const isTest = state.workflowMode === "test";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            className={cn(
              isTest &&
                "bg-warning/10 text-warning hover:bg-warning/15 hover:text-warning"
            )}
            size={BAR_CONTROL_SIZE}
            variant="ghost"
          />
        }
      >
        <CircleDot className="size-3" data-icon="inline-start" />
        {isTest ? "Test mode" : "Live mode"}
        <ChevronDown className="size-3 opacity-50" data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Run mode</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={(mode) => {
              if (mode === "live" || mode === "test") {
                void actions.handleSetWorkflowMode(mode);
              }
            }}
            value={state.workflowMode}
          >
            <DropdownMenuRadioItem disabled={!state.isOwner} value="test">
              <span>
                Test mode
                <span className="block text-muted-foreground text-xs font-normal">
                  Routes configured messages to test recipients.
                </span>
              </span>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem disabled={!state.isOwner} value="live">
              <span>
                Live mode
                <span className="block text-muted-foreground text-xs font-normal">
                  Sends messages to configured recipients.
                </span>
              </span>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
  state,
  actions,
  onAddStep,
}: {
  state: WorkflowToolbarState;
  actions: WorkflowToolbarActions;
  onAddStep: () => void;
}) {
  const editingLocked = useAtomValue(canvasEditingLockedAtom);
  const hasCopiedSelection = useAtomValue(hasCopiedSelectionAtom);
  const copySelection = useSetAtom(copySelectionAtom);
  const pasteSelection = useSetAtom(pasteCopiedSelectionAtom);
  const duplicateSelection = useSetAtom(duplicateSelectionAtom);
  const groupSelection = useSetAtom(groupSelectionAtom);
  const catalog = useExtensionCatalog();
  const { fitView } = useReactFlow();
  const { canReflow, reflow } = useReflowLayout();
  // Every handler behind these takes either modifier, so the label is the only
  // thing that has to know which key this keyboard has.
  const shortcuts = editorShortcutLabels(isApplePlatform(currentPlatform()));
  const selectedIds = new Set(
    state.nodes.filter((node) => node.selected).map((node) => node.id)
  );
  const hasCopyableSelection = state.nodes.some(
    (node) =>
      node.selected && node.data.type !== "lifecycle" && node.type !== "add"
  );
  const grouping = analyzeGroupableSelection(
    state.nodes,
    state.edges,
    selectedIds,
    catalog
  );

  const commands = workflowCommands({
    state: {
      currentWorkflowId: state.currentWorkflowId,
      workflowMode: state.workflowMode,
      isExecuting: state.isExecuting,
      isGenerating: state.isGenerating,
      isSaving: state.isSaving,
      hasNodes: state.nodes.some((node) => node.type !== "add"),
      canUndo: state.canUndo,
      canRedo: state.canRedo,
      canReflow,
      editingLocked,
    },
    shortcuts,
    callbacks: {
      addStep: onAddStep,
      run: () => void actions.handleExecute(),
      switchMode: (mode) => void actions.handleSetWorkflowMode(mode),
      undo: state.undo,
      redo: state.redo,
      reflow,
    },
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button size={BAR_CONTROL_SIZE} variant="ghost" />}
      >
        Actions
        <ChevronDown className="size-3 opacity-50" data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {commands.map((command, index) => (
          <Fragment key={command.id}>
            {index > 0 &&
            (command.group !== commands[index - 1]?.group ||
              command.id === "undo") ? (
              <DropdownMenuSeparator />
            ) : null}
            <DropdownMenuItem
              disabled={command.disabled}
              onClick={command.execute}
            >
              <WorkflowCommandIcon id={command.id} />
              {command.label}
              {command.hint ? (
                <DropdownMenuShortcut>{command.hint}</DropdownMenuShortcut>
              ) : null}
            </DropdownMenuItem>
          </Fragment>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Maximize2 />
            Keyboard shortcuts
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56">
            <DropdownMenuItem
              onClick={() => void fitView({ padding: 0.2, duration: 300 })}
            >
              <Maximize2 />
              Fit view
              <DropdownMenuShortcut>{shortcuts.fitView}</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!hasCopyableSelection || editingLocked}
              onClick={() => void copySelection()}
            >
              <Copy />
              Copy selection
              <DropdownMenuShortcut>{shortcuts.copy}</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!hasCopiedSelection || editingLocked}
              onClick={() => void pasteSelection()}
            >
              <ClipboardPaste />
              Paste
              <DropdownMenuShortcut>{shortcuts.paste}</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!hasCopyableSelection || editingLocked}
              onClick={() => void duplicateSelection()}
            >
              <CopyPlus />
              Duplicate selection
              <DropdownMenuShortcut>{shortcuts.duplicate}</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!grouping.ok || editingLocked}
              onClick={() => void groupSelection({ catalog })}
            >
              <GroupIcon />
              Group selection
              <DropdownMenuShortcut>{shortcuts.group}</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
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
  const openPalette = useSetAtom(openCommandPaletteAtom);
  // For non-owners viewing public workflows, don't show toolbar actions.
  if (workflowId && !state.isOwner) {
    return null;
  }

  // Adding a step is the palette's own job, so the menu item opens it on the
  // node-type page rather than dropping a node with no action on it and leaving
  // the picker to the config panel. Placement is the palette's too: it lands in
  // the middle of the canvas, moved clear of whatever is already there.
  const handleAddStep = () => {
    openPalette({ id: "add-step" });
  };

  return (
    <>
      <ActionsMenu actions={actions} onAddStep={handleAddStep} state={state} />
      <CommandPalette actions={actions} state={state} />
    </>
  );
}

/** The toolbar's right-hand controls stay together when a narrow bar scrolls. */
export function ToolbarPublishControls({
  actions,
  state,
}: {
  actions: WorkflowToolbarActions;
  state: WorkflowToolbarState;
}) {
  const { push } = useOverlay();
  const { openSheet } = useConfigurationSheet();
  const [selectedNodeId] = useAtom(selectedNodeAtom);
  const [selectedEdgeId] = useAtom(selectedEdgeAtom);
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const deleteNode = useSetAtom(deleteNodeAtom);
  const deleteEdge = useSetAtom(deleteEdgeAtom);
  const isMobile = useIsMobile();
  const editingLocked = useAtomValue(canvasEditingLockedAtom);
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  const hasSelection = selectedNode || selectedEdge;
  const publication = state.publication;
  const publishDisabled =
    editingLocked ||
    state.isSaving ||
    !state.nodes.some((node) => node.type !== "add") ||
    (publication?.isPublished &&
      !publication.hasUnpublishedChanges &&
      !state.hasUnsavedChanges);
  const proposedVersion = publication?.publishedVersion
    ? publication.publishedVersion + 1
    : undefined;

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

  return (
    <>
      <WorkflowModeMenu actions={actions} state={state} />
      {state.isOwner ? (
        <>
          <PublishButton
            disabled={publishDisabled || actions.isComparing}
            handlePublish={actions.handlePublish}
            isPublishing={actions.isPublishing}
            proposedVersion={proposedVersion}
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
              aria-label="Configuration"
              onClick={openSheet}
              size="icon"
              title="Configuration"
              variant="outline"
            >
              <Settings2 className="size-4" />
            </Button>
            {hasSelection && (
              <Button
                aria-label="Delete selection"
                disabled={editingLocked}
                onClick={handleDeleteConfirm}
                size="icon"
                title="Delete"
                variant="outline"
              >
                <Trash2 className="size-4" />
              </Button>
            )}
          </ButtonGroup>
          {actions.publishReview ? (
            <PublishReviewDialog
              isPublishing={actions.isPublishing}
              mode={state.workflowMode}
              onConfirm={actions.confirmPublish}
              onOpenChange={actions.setPublishReviewOpen}
              open
              review={actions.publishReview.review}
            />
          ) : null}
        </>
      ) : null}
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
