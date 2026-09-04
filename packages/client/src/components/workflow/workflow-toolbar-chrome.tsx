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
  Check,
  ChevronDown,
  CirclePlay,
  Copy,
  Eraser,
  Loader2,
  Pencil,
  Play,
  Plus,
  Search,
  Settings2,
  Trash2,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { ConfirmOverlay } from "#src/components/overlays/confirm-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { useConfigurationSheet } from "#src/hooks/use-configuration-sheet";
import { useIsMobile } from "#src/hooks/use-mobile";
import { Button, buttonVariants } from "#src/components/ui/button";
import {
  ButtonGroup,
  ButtonGroupSeparator,
} from "#src/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "#src/components/ui/dropdown-menu";
import { Separator } from "#src/components/ui/separator";
import { WorkflowIcon } from "#src/components/ui/workflow-icon";
import { CommandPalette } from "#src/components/workflow/command-palette";
import { PublishReviewDialog } from "#src/components/workflow/publish-review-dialog";
import { CreateWorkflowDialog } from "#src/components/workflow/create-workflow-dialog";
import { RenameWorkflowDialog } from "#src/components/workflow/rename-workflow-dialog";
import { useWorkflowCommands } from "#src/components/workflow/use-workflow-commands";
import {
  currentPlatform,
  editorShortcutLabels,
  isApplePlatform,
} from "#src/lib/shortcut-label";
import {
  WorkflowCommandIcon,
  isDraftRunDisabled,
  isPublishedRunDisabled,
  isWorkflowPublishDisabled,
  type WorkflowCommand,
} from "#src/lib/workflow-commands";
import {
  publishedRunLabel,
  runCommandLabel,
  type WorkflowRunGraph,
} from "#src/lib/workflow-run-labels";
import type { WorkflowToolbarActions } from "#src/components/workflow/workflow-toolbar-handlers";
import type { WorkflowToolbarState } from "#src/components/workflow/workflow-toolbar-state";
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
  label,
}: {
  isPublishing: boolean;
  disabled: boolean;
  handlePublish: () => void;
  label: string;
}) {
  return (
    // Publish is the one control here that changes what real customers receive,
    // and it used to be the fifth identical 36px square in a row of six. It gets
    // the primary fill and a written label at every width.
    <Button
      disabled={disabled}
      onClick={handlePublish}
      size={BAR_CONTROL_SIZE}
      variant="default"
    >
      {isPublishing ? (
        <Loader2
          className="size-3.5 animate-spin motion-reduce:animate-none"
          data-icon="inline-start"
        />
      ) : (
        <Upload className="size-3.5" data-icon="inline-start" />
      )}
      {label}
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
      <span className="truncate">Search commands or add a step</span>
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

/** A compact route into node search while the full command search field is hidden. */
export function FindNodeTrigger() {
  const openPalette = useSetAtom(openCommandPaletteAtom);
  const refusal = useAtomValue(commandPaletteRefusalAtom);

  return (
    <Button
      aria-label="Find a node"
      className="min-[70rem]:hidden"
      disabled={refusal !== null}
      onClick={() => openPalette({ id: "find-node" })}
      size="icon"
      title={refusal ?? "Find a node"}
      variant="outline"
    >
      <Search className="size-4" />
    </Button>
  );
}

/**
 * The state both run commands are gated on. The Actions menu and the command
 * palette read the same gate functions, so a new condition reaches every
 * surface that offers a run.
 */
function runEligibility(
  state: WorkflowToolbarState,
  actions: WorkflowToolbarActions,
  editingLocked: boolean
) {
  return {
    currentWorkflowId: state.currentWorkflowId,
    isExecuting: state.isExecuting,
    isPreflighting: actions.isPreflighting,
    isGenerating: state.isGenerating,
    hasNodes: state.nodes.some((node) => node.type !== "add"),
    publishedVersion: state.publication?.publishedVersion,
    canRunDraft: state.canExecute && state.canUpdate && !editingLocked,
    canRunPublished:
      state.canExecute && state.canReadVersionGraph && !editingLocked,
  };
}

/** One offered run command: its label, whether it is disabled, and what it starts. */
type RunCommand = {
  readonly id: WorkflowRunGraph;
  readonly label: string;
  /** The glyph itself, so each surface renders it at its own size. */
  readonly Icon: LucideIcon;
  readonly disabled: boolean;
  readonly run: () => void;
};

/**
 * Every run command this workflow offers, in render order.
 *
 * The draft command comes first and sits on the split button's face. It runs
 * the canvas with test recipients, whatever the Published mode is. The published
 * command follows, labelled with its version number and mode, or with the reason
 * it is disabled before the first publish. Neither command reads unsaved
 * changes to pick a graph; the choice of command picks the graph.
 *
 * The split button and the mobile overflow menu both render this list, so a new
 * command reaches both.
 */
function runCommands(
  state: WorkflowToolbarState,
  actions: WorkflowToolbarActions,
  editingLocked: boolean
): readonly [RunCommand, ...RunCommand[]] {
  const eligibility = runEligibility(state, actions, editingLocked);

  return [
    {
      id: "draft",
      label: runCommandLabel({ graph: "draft" }),
      Icon: Play,
      disabled: !eligibility.canRunDraft || isDraftRunDisabled(eligibility),
      run: () => void actions.handleExecute("draft"),
    },
    {
      id: "published",
      label: publishedRunLabel({
        workflowMode: state.workflowMode,
        publishedVersion: eligibility.publishedVersion,
      }),
      Icon: CirclePlay,
      disabled:
        !eligibility.canRunPublished || isPublishedRunDisabled(eligibility),
      run: () => void actions.handleExecute("published"),
    },
  ];
}

/** One run command as a menu row. Every surface except the split button face uses this. */
function RunCommandMenuItem({ command }: { command: RunCommand }) {
  return (
    <DropdownMenuItem disabled={command.disabled} onClick={command.run}>
      <command.Icon />
      {command.label}
    </DropdownMenuItem>
  );
}

/**
 * Whether Publish is disabled, and the label for the control, which names the
 * version number the next publish takes. The desktop button and the mobile menu
 * item share this hook so they cannot disagree.
 */
function usePublishGate(
  state: WorkflowToolbarState,
  actions: WorkflowToolbarActions
) {
  const editingLocked = useAtomValue(canvasEditingLockedAtom);
  const publishedVersion = state.publication?.publishedVersion;
  const proposedVersion = publishedVersion ? publishedVersion + 1 : undefined;

  return {
    disabled:
      !state.canPublish ||
      isWorkflowPublishDisabled({
        editingLocked,
        isSaving: state.isSaving,
        isComparing: actions.isComparing,
        isPublishing: actions.isPublishing,
        isPreflighting: actions.isPreflighting,
        hasNodes: state.nodes.some((node) => node.type !== "add"),
        hasUnsavedChanges: state.hasUnsavedChanges,
        publication: state.publication,
      }),
    // Include the version number whenever there is one, so the control states
    // exactly which version a press creates.
    label: actions.isPublishing
      ? "Publishing"
      : proposedVersion
        ? `Publish v${proposedVersion}`
        : "Publish",
  };
}

/**
 * The run commands as one split control. The first command sits on the face and
 * the rest sit behind the chevron.
 */
export function RunSplitButton({
  actions,
  state,
}: {
  actions: WorkflowToolbarActions;
  state: WorkflowToolbarState;
}) {
  const editingLocked = useAtomValue(canvasEditingLockedAtom);
  const [face, ...behindTheChevron] = runCommands(
    state,
    actions,
    editingLocked
  );

  return (
    // The two halves are one control, so the group carries the name. Without
    // it a screen reader announces the chevron with no context.
    <ButtonGroup aria-label="Run">
      <Button
        // The separator supplies the divider inside this control, so the face
        // drops its right border. Two outline halves would draw that edge at
        // twice the weight of the other hairlines in the bar.
        className="border-r-0"
        disabled={face.disabled}
        onClick={face.run}
        size={BAR_CONTROL_SIZE}
        variant="outline"
      >
        <face.Icon className="size-3.5" data-icon="inline-start" />
        {face.label}
      </Button>
      {/* The separator joins the two halves into one split control. The label
          runs the draft; the chevron opens the other run commands. */}
      <ButtonGroupSeparator />
      {/* Stays enabled with nothing published, because the menu item inside
          names that reason. */}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label="More ways to run"
              size="icon"
              variant="outline"
            />
          }
        >
          <ChevronDown className="size-3 opacity-50" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {behindTheChevron.map((command) => (
            <RunCommandMenuItem command={command} key={command.id} />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}

/**
 * The same run commands plus Publish as menu items, for the overflow menu the
 * trailing group collapses into below `md`. Each row reads the same list and
 * the same gate as its desktop control, so the disabled states match.
 */
export function RunPublishMenuItems({
  actions,
  state,
}: {
  actions: WorkflowToolbarActions;
  state: WorkflowToolbarState;
}) {
  const publish = usePublishGate(state, actions);
  const editingLocked = useAtomValue(canvasEditingLockedAtom);

  return (
    <>
      {runCommands(state, actions, editingLocked).map((command) => (
        <RunCommandMenuItem command={command} key={command.id} />
      ))}
      <DropdownMenuItem
        disabled={publish.disabled}
        onClick={actions.handlePublish}
      >
        <Upload />
        {publish.label}
      </DropdownMenuItem>
    </>
  );
}

/**
 * What the builder can do to the open workflow, as one menu.
 *
 * Each item states its own name, which the six grey icon squares this replaced
 * could only do on hover. Only shortcuts that are bound appear beside an item.
 * The run commands are left out: the toolbar's run control is right beside this
 * menu, and the command palette lists them for anyone searching by name.
 */
function ActionsMenu({ commands }: { commands: readonly WorkflowCommand[] }) {
  // Canvas commands move to the shortcuts submenu below, and a `paletteOnly`
  // command has its own control in the toolbar, so listing it here would offer
  // the same press twice in one bar.
  const menuCommands = commands.filter(
    (command) => command.group !== "canvas" && !command.paletteOnly
  );
  const canvasCommands = commands.filter(
    (command) => command.group === "canvas"
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button size={BAR_CONTROL_SIZE} variant="ghost" />}
      >
        Actions
        <ChevronDown className="size-3 opacity-50" data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {menuCommands.map((command, index) => (
          <Fragment key={command.id}>
            {index > 0 &&
            (command.group !== menuCommands[index - 1]?.group ||
              command.id === "undo") ? (
              <DropdownMenuSeparator />
            ) : null}
            <DropdownMenuItem
              disabled={command.disabled}
              onClick={command.execute}
            >
              <WorkflowCommandIcon id={command.id} />
              {/* The detail line says what the label has no room for, and on
                  a disabled row it gives the reason. It is styled the same way
                  as the Published mode menu's descriptions. */}
              <span>
                {command.label}
                {command.detail ? (
                  <span className="block font-normal text-muted-foreground text-xs">
                    {command.detail}
                  </span>
                ) : null}
              </span>
              {command.hint ? (
                <DropdownMenuShortcut>{command.hint}</DropdownMenuShortcut>
              ) : null}
            </DropdownMenuItem>
          </Fragment>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <WorkflowCommandIcon id="fit-view" />
            Keyboard shortcuts
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56">
            {canvasCommands.map((command) => (
              <DropdownMenuItem
                disabled={command.disabled}
                key={command.id}
                onClick={command.execute}
              >
                <WorkflowCommandIcon id={command.id} />
                {command.label}
                {command.hint ? (
                  <DropdownMenuShortcut>{command.hint}</DropdownMenuShortcut>
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ToolbarActions({
  state,
  actions,
}: {
  state: WorkflowToolbarState;
  actions: WorkflowToolbarActions;
}) {
  return <OwnerToolbarActions actions={actions} state={state} />;
}

function OwnerToolbarActions({
  state,
  actions,
}: {
  state: WorkflowToolbarState;
  actions: WorkflowToolbarActions;
}) {
  const openPalette = useSetAtom(openCommandPaletteAtom);

  // Adding a step is the palette's own job, so the menu item opens it on the
  // node-type page rather than dropping a node with no action on it and leaving
  // the picker to the config panel. Placement is the palette's too: it lands in
  // the middle of the canvas, moved clear of whatever is already there.
  const handleAddStep = () => {
    openPalette({ id: "add-step" });
  };
  const commands = useWorkflowCommands({
    state,
    actions,
    onAddStep: handleAddStep,
  });

  return (
    <>
      <ActionsMenu commands={commands} />
      <CommandPalette commands={commands} />
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
  const publish = usePublishGate(state, actions);

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
      {state.canExecute || state.canPublish ? (
        <div className="hidden shrink-0 items-center gap-2 md:flex">
          <Separator
            className="data-vertical:h-4 data-vertical:self-center"
            orientation="vertical"
          />
          {state.canExecute ? (
            <RunSplitButton actions={actions} state={state} />
          ) : null}
          {state.canPublish ? (
            <PublishButton
              disabled={publish.disabled}
              handlePublish={actions.handlePublish}
              isPublishing={actions.isPublishing}
              label={publish.label}
            />
          ) : null}
        </div>
      ) : null}
      {state.canUpdate ? (
        <>
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
        </>
      ) : null}
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
  workflowId?: string | undefined;
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

  // Each operation keeps its own authorization check. Rename updates the current
  // draft, while Duplicate and Delete only need the saved workflow id.
  const canRename = Boolean(workflowId) && state.canUpdate;
  const canDuplicate = Boolean(workflowId) && state.canDuplicate;
  const canDelete = Boolean(workflowId) && state.canDelete;
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
              saved. */}
          <span className="truncate">
            {state.workflowName || "Untitled workflow"}
          </span>
          <ChevronDown className="size-3 opacity-50" data-icon="inline-end" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {canRename || canDuplicate ? (
            <>
              {canRename ? (
                <DropdownMenuItem
                  onClick={() => {
                    setRenameDialogSession((session) => session + 1);
                    setIsRenameDialogOpen(true);
                  }}
                >
                  <Pencil />
                  Rename
                </DropdownMenuItem>
              ) : null}
              {canDuplicate ? (
                <DropdownMenuItem
                  disabled={actions.isDuplicating}
                  onClick={actions.handleDuplicate}
                >
                  {actions.isDuplicating ? (
                    <Loader2 className="animate-spin motion-reduce:animate-none" />
                  ) : (
                    <Copy />
                  )}
                  Duplicate workflow
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
            </>
          ) : null}

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
            {state.canCreate ? (
              <DropdownMenuItem
                onClick={() => {
                  setCreateDialogSession((session) => session + 1);
                  setIsCreateDialogOpen(true);
                }}
              >
                <Plus />
                New workflow
              </DropdownMenuItem>
            ) : null}
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
          {state.canUpdate && (
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

          {canDelete ? (
            <DropdownMenuItem
              onClick={actions.handleDeleteWorkflow}
              variant="destructive"
            >
              <Trash2 />
              Delete workflow
            </DropdownMenuItem>
          ) : null}

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
