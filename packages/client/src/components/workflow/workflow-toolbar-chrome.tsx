/**
 * The menu bar's controls: the Workflows page link, the workflow menu, the
 * palette's trigger and Publish. Behaviour hooks live in
 * `workflow-toolbar-handlers`.
 *
 * Everything here sits in a bar of fixed height above the canvas, so nothing
 * may wrap or grow with its content: a taller bar is a shorter graph, and React
 * Flow reacts to every pixel of it. A long workflow name truncates.
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  ChevronDown,
  CirclePlay,
  Copy,
  Loader2,
  PanelLeft,
  Sparkles,
  Pause,
  Pencil,
  Play,
  Search,
  Settings2,
  Trash2,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { compact } from "es-toolkit/array";
import { toast } from "sonner";
import { useShownMobileReveal } from "#src/components/workflow/canvas-reveal/canvas-reveal-state";
import { useRevealNavigation } from "#src/components/workflow/canvas-reveal/use-reveal-navigation";
import { activeWorkspaceAddressAtom } from "#src/lib/workflow-workspace-navigation";
import { Button, buttonVariants } from "#src/components/ui/button";
import {
  ButtonGroup,
  ButtonGroupSeparator,
} from "#src/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#src/components/ui/dropdown-menu";
import { Kbd } from "#src/components/ui/kbd";
import { ControlTooltip } from "#src/components/ui/control-tooltip";
import { Separator } from "#src/components/ui/separator";
import {
  openRenameWorkflowDialogAtom,
  renameWorkflowDialogAtom,
  type WorkflowWorkspaceView,
  workflowWorkspaceViewAtom,
} from "#src/lib/workflow-ui-store";
import type { PaletteMenuCommand } from "#src/hooks/use-app-commands";
import { WorkflowIcon } from "#src/components/ui/workflow-icon";
import { CommandPalette } from "#src/components/workflow/command-palette";
import { PublicationChip } from "#src/components/workflow/publication-chip";
import { useSetWorkflowPaused } from "#src/hooks/use-set-workflow-paused";
import { can, canUseBuildAgent } from "#src/lib/authorization";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { RenameWorkflowDialog } from "#src/components/workflow/rename-workflow-dialog";
import { useWorkflowCommands } from "#src/components/workflow/use-workflow-commands";
import { useOutlineControls } from "#src/components/workflow/columns/use-outline-controls";
import { focusAgentComposerAtom } from "#src/lib/workflow-ui-store";
import { isAgentEnabled } from "#src/lib/extensions";
import { orpcQuery } from "#src/lib/rpc-query";
import type { WorkflowApiPayload } from "@wfgraph/shared/graph/api-contracts";
import { isBlank } from "@wfgraph/shared/types/string";
import {
  OUTLINE_SHORTCUT_KEY,
  currentPlatform,
  editorShortcutLabels,
  isApplePlatform,
} from "#src/lib/shortcut-label";
import {
  draftViewReason,
  isDraftRunDisabled,
  isPublishedRunDisabled,
  isWorkflowPublishDisabled,
  publishCommandLabel,
  runDisabledReason,
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
import { canvasEditingLockedAtom } from "#src/lib/workflow-graph-store";

/**
 * Put the workflow's id on the clipboard.
 *
 * The write can be refused outright -- an insecure origin, or a browser that
 * withholds the permission -- so the failure is reported rather than swallowed:
 * a menu item that looks like it worked and did not is worse than one that says
 * so.
 */
export async function copyWorkflowId(workflowId: string) {
  try {
    await navigator.clipboard.writeText(workflowId);
    toast.success("Workflow ID copied");
  } catch {
    toast.error("Could not copy the workflow ID");
  }
}

/** The height every control in the bar shares: 28px inside a 44px row. */
const BAR_CONTROL_SIZE = "default" as const;

/** The way out of the editor to the Workflows page. It sits outside the
 *  workflow menu, because a dropdown is a place nobody looks for navigation. */
export function WorkflowsPageLink() {
  return (
    // A router link wearing the button's styles rather than a `Button` handed a
    // link to render: Base UI's button either logs that its element is not a
    // <button>, or takes `nativeButton={false}` and announces this link as a
    // button. It stays a link, which is what makes middle-click and the context
    // menu open the Workflows page in a tab.
    <ControlTooltip label="Workflows">
      <Link
        aria-label="Workflows"
        className={buttonVariants({ size: "icon", variant: "secondary" })}
        to="/"
      >
        <WorkflowIcon className="size-3.5" />
      </Link>
    </ControlTooltip>
  );
}

function PublishButton({
  isPublishing,
  disabled,
  reason,
  handlePublish,
  label,
}: {
  isPublishing: boolean;
  disabled: boolean;
  /** Why the button is disabled, when the view states one. */
  reason: string | null;
  handlePublish: () => void;
  label: string;
}) {
  // Publish is the one control here that changes what real customers receive.
  // It gets the primary fill and a written label at every width.
  //
  // It stays focusable while disabled, which it is from the press until the
  // review dialog closes, so focus has a control to come back to.
  const button = (
    <Button
      disabled={disabled}
      focusableWhenDisabled
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
  return disabled && reason !== null ? (
    <ControlTooltip label={reason}>{button}</ControlTooltip>
  ) : (
    button
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
      <Kbd aria-hidden="true" className="ml-auto">
        {shortcuts.palette}
      </Kbd>
    </Button>
  );
}

/**
 * A compact route to the outline's "Filter steps" field while the full command
 * search field is hidden. It brings the outline into view when it is collapsed.
 */
export function FindStepTrigger() {
  const outline = useOutlineControls();
  const shortcut = editorShortcutLabels(
    isApplePlatform(currentPlatform())
  ).findStep;

  return (
    <ControlTooltip label="Find a step" shortcut={shortcut}>
      <Button
        aria-keyshortcuts="Meta+F Control+F"
        aria-label="Find a step"
        className="min-[70rem]:hidden"
        onClick={outline.findStep}
        size="icon"
        variant="outline"
      >
        <Search className="size-4" />
      </Button>
    </ControlTooltip>
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
    isPaused: state.publication?.isPaused === true,
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
  /** Why the command is disabled, when the view states one. */
  readonly reason: string | null;
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
  editingLocked: boolean,
  view: WorkflowWorkspaceView
): readonly [RunCommand, ...RunCommand[]] {
  const eligibility = runEligibility(state, actions, editingLocked);
  const reason = runDisabledReason({ view, isPaused: eligibility.isPaused });

  return [
    {
      id: "draft",
      label: runCommandLabel({ graph: "draft" }),
      Icon: Play,
      disabled: !eligibility.canRunDraft || isDraftRunDisabled(eligibility),
      reason,
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
      reason,
      run: () => void actions.handleExecute("published"),
    },
  ];
}

/** One run command as a menu row. Every surface except the split button face uses this. */
function RunCommandMenuItem({ command }: { command: RunCommand }) {
  return (
    <DropdownMenuItem disabled={command.disabled} onClick={command.run}>
      <command.Icon />
      <MenuItemText
        detail={command.disabled ? command.reason : null}
        label={command.label}
      />
    </DropdownMenuItem>
  );
}

/**
 * A menu row's label, with the reason a disabled row is off as a detail line,
 * styled as the Actions menu styles its detail lines.
 */
function MenuItemText({
  label,
  detail,
}: {
  label: string;
  detail: string | null;
}) {
  return (
    <span>
      {label}
      {detail === null ? null : (
        <span className="block font-normal text-muted-foreground text-xs">
          {detail}
        </span>
      )}
    </span>
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
  const view = useAtomValue(workflowWorkspaceViewAtom);

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
    reason: draftViewReason(view, "publish"),
    // Include the version number whenever there is one, so the control states
    // exactly which version a press creates.
    label: actions.isPublishing
      ? "Publishing"
      : publishCommandLabel(state.publication?.publishedVersion),
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
  const view = useAtomValue(workflowWorkspaceViewAtom);
  const [face, ...behindTheChevron] = runCommands(
    state,
    actions,
    editingLocked,
    view
  );
  const shortcuts = editorShortcutLabels(isApplePlatform(currentPlatform()));
  // A disabled face says why, where a reason exists; an enabled one names its
  // shortcut.
  const faceTooltip =
    face.disabled && face.reason !== null
      ? { label: face.reason, shortcut: undefined }
      : { label: face.label, shortcut: shortcuts.run };

  return (
    // The two halves are one control, so the group carries the name. Without
    // it a screen reader announces the chevron with no context.
    <ButtonGroup aria-label="Run">
      <ControlTooltip label={faceTooltip.label} shortcut={faceTooltip.shortcut}>
        <Button
          // The separator supplies the divider inside this control, so the
          // face drops its right border. Two outline halves would draw that
          // edge at twice the weight of the other hairlines in the bar. The
          // square right corners are the group's, set here because the
          // tooltip can stand between the face and the group.
          //
          // Focusable while disabled, which it is while a run starts, so
          // the Run draft dialog has a control to give focus back to.
          className="rounded-r-none border-r-0"
          disabled={face.disabled}
          focusableWhenDisabled
          onClick={face.run}
          size={BAR_CONTROL_SIZE}
          variant="outline"
        >
          <face.Icon className="size-3.5" data-icon="inline-start" />
          {face.label}
        </Button>
      </ControlTooltip>
      {/* The separator joins the two halves into one split control. The label
          runs the draft; the chevron opens the other run commands. */}
      <ButtonGroupSeparator />
      {/* Stays enabled with nothing published, because the menu item inside
          names that reason. */}
      <DropdownMenu>
        <ControlTooltip label="More ways to run">
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
        </ControlTooltip>
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
  const view = useAtomValue(workflowWorkspaceViewAtom);

  return (
    <>
      {runCommands(state, actions, editingLocked, view).map((command) => (
        <RunCommandMenuItem command={command} key={command.id} />
      ))}
      <DropdownMenuItem
        disabled={publish.disabled}
        onClick={actions.handlePublish}
      >
        <Upload />
        <MenuItemText
          detail={publish.disabled ? publish.reason : null}
          label={publish.label}
        />
      </DropdownMenuItem>
    </>
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
  const menuCommands = useWorkflowMenuCommands(state, actions);

  return (
    <CommandPalette
      commands={commands}
      menuCommands={menuCommands}
      workflows={state.allWorkflows}
    />
  );
}

/**
 * Which of the workflow menu's own rows the open workflow offers. The menu and
 * the command palette both read this, so the two offer the same rows.
 */
function workflowMenuOffers(
  state: WorkflowToolbarState,
  workflowId: string | undefined
) {
  const isPaused = state.publication?.isPaused === true;
  return {
    // Rename updates the current draft, while Duplicate and Delete only need
    // the saved workflow id.
    rename: Boolean(workflowId) && state.canUpdate,
    duplicate: Boolean(workflowId) && state.canDuplicate,
    delete: Boolean(workflowId) && state.canDelete,
    // A workflow with no published version starts no run, so there is nothing
    // for a pause to stop. A paused one can always resume.
    togglePause:
      Boolean(workflowId) &&
      can(WfGraphOperations.workflowBulkLifecycle.id) &&
      (isPaused || state.publication?.isPublished === true),
    isPaused,
  };
}

/**
 * The workflow menu's commands for the command palette, in the menu's words:
 * Rename, Duplicate workflow, Pause or Resume workflow, and Copy workflow ID,
 * with the command that hides and shows the floating outline.
 */
function useWorkflowMenuCommands(
  state: WorkflowToolbarState,
  actions: WorkflowToolbarActions
): readonly PaletteMenuCommand[] {
  const workflowId = state.currentWorkflowId ?? undefined;
  const offers = workflowMenuOffers(state, workflowId);
  const pause = useSetWorkflowPaused(workflowId);
  const openRename = useSetAtom(openRenameWorkflowDialogAtom);
  const outline = useOutlineControls();
  const focusAgentComposer = useSetAtom(focusAgentComposerAtom);
  const commands: PaletteMenuCommand[] = [];
  if (offers.rename) {
    commands.push({
      id: "rename",
      label: "Rename",
      keywords: "Rename workflow name title",
      disabled: false,
      Icon: Pencil,
      execute: openRename,
    });
  }
  if (offers.duplicate) {
    commands.push({
      id: "duplicate-workflow",
      label: "Duplicate workflow",
      keywords: "Duplicate workflow copy clone",
      disabled: actions.isDuplicating,
      Icon: Copy,
      execute: actions.handleDuplicate,
    });
  }
  if (offers.togglePause) {
    commands.push({
      id: "toggle-pause",
      label: offers.isPaused ? "Resume workflow" : "Pause workflow",
      keywords: "Pause Resume workflow stop start runs",
      disabled: pause.isPending,
      Icon: offers.isPaused ? Play : Pause,
      execute: () => pause.setPaused(!offers.isPaused),
    });
  }
  if (outline.canHide) {
    commands.push({
      id: "toggle-outline",
      label: outline.toggleLabel,
      keywords: "Outline hide show steps list",
      hint: OUTLINE_SHORTCUT_KEY,
      disabled: false,
      Icon: PanelLeft,
      execute: outline.toggle,
    });
  }
  if (workflowId !== undefined && isAgentEnabled() && canUseBuildAgent()) {
    commands.push({
      id: "show-agent",
      label: "Agent",
      keywords: "Agent build assistant chat describe AI",
      disabled: false,
      Icon: Sparkles,
      execute: () => focusAgentComposer(),
    });
  }
  if (workflowId !== undefined) {
    commands.push({
      id: "copy-workflow-id",
      label: "Copy workflow ID",
      keywords: "Copy workflow ID identifier clipboard",
      disabled: false,
      Icon: Copy,
      execute: () => void copyWorkflowId(workflowId),
    });
  }
  return commands;
}

/** The toolbar's right-hand controls stay together when a narrow bar scrolls. */
export function ToolbarPublishControls({
  actions,
  state,
}: {
  actions: WorkflowToolbarActions;
  state: WorkflowToolbarState;
}) {
  const navigation = useRevealNavigation();
  const address = useAtomValue(activeWorkspaceAddressAtom);
  const mobileReveal = useShownMobileReveal();
  const publish = usePublishGate(state, actions);

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
              reason={publish.reason}
            />
          ) : null}
        </div>
      ) : null}
      {state.canUpdate && mobileReveal === null ? (
        // Hidden at `md` and wider, the breakpoint that shows the details
        // column in place of the mobile sheets, so this button and the
        // details column are never on screen together. An open mobile Reveal sheet already shows
        // the selection, so the button is absent while one shows.
        <ControlTooltip label="Configuration">
          <Button
            aria-label="Configuration"
            className="md:hidden"
            onClick={() => navigation.openInspector(address)}
            size="icon"
            variant="outline"
          >
            <Settings2 className="size-4" />
          </Button>
        </ControlTooltip>
      ) : null}
    </>
  );
}

const PUBLICATION_COMMAND_IDS = ["version-history", "review-changes"] as const;

/**
 * The two publication commands the publication chip offers, Version history
 * and Review changes, gated as the palette gates them.
 */
function usePublicationCommands(
  state: WorkflowToolbarState,
  actions: WorkflowToolbarActions
): readonly WorkflowCommand[] {
  const commands = useWorkflowCommands({
    state,
    actions,
    // Neither command adds a step.
    onAddStep: () => undefined,
  });
  return compact(
    PUBLICATION_COMMAND_IDS.map((id) =>
      commands.find((command) => command.id === id)
    )
  );
}

/** The publication chip beside the workflow's name. */
export function WorkflowPublicationChip({
  workflowId,
  state,
  actions,
}: {
  workflowId?: string | undefined;
  state: WorkflowToolbarState;
  actions: WorkflowToolbarActions;
}) {
  const commands = usePublicationCommands(state, actions);
  return <PublicationChip commands={commands} workflowId={workflowId} />;
}

/** The workflow's description, read off its `getById` payload. */
function selectWorkflowDescription(payload: WorkflowApiPayload) {
  return payload.description;
}

/**
 * The open workflow's description at the top of its menu, read from the
 * `getById` entry the editor already holds, so it costs no request. A
 * workflow with no description shows nothing.
 */
function WorkflowDescription({ workflowId }: { workflowId: string }) {
  const description = useQuery({
    ...orpcQuery.workflow.getById.queryOptions({ input: { workflowId } }),
    staleTime: Number.POSITIVE_INFINITY,
    select: selectWorkflowDescription,
  }).data;
  if (description === undefined || isBlank(description)) {
    return null;
  }
  return (
    <>
      <p
        className="break-words px-2 py-1.5 text-muted-foreground text-xs"
        data-slot="workflow-description"
      >
        {description}
      </p>
      <DropdownMenuSeparator />
    </>
  );
}

/**
 * The one menu for the open workflow, under its name: the workflow's
 * description when it has one, then Rename, Duplicate, Copy workflow ID and
 * Delete. Pause, Version history and Review changes are
 * in the publication chip's menu, beside the state they change. What is about
 * the app rather than this workflow is under Settings.
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
  // Rename keeps its dialog's open state in an atom, because the command
  // palette opens it too.
  const [renameDialog, setRenameDialog] = useAtom(renameWorkflowDialogAtom);
  const openRename = useSetAtom(openRenameWorkflowDialogAtom);

  // Each operation keeps its own authorization check.
  const offers = workflowMenuOffers(state, workflowId);
  const currentWorkflowId = state.currentWorkflowId;
  // The names the server would refuse, which is every workflow's but this one's.
  const otherWorkflowNames = state.allWorkflows
    .filter((workflow) => workflow.id !== currentWorkflowId)
    .map((workflow) => workflow.name);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              // At phone width the name still shows its first letters
              // rather than shrinking to one: the menus beside it give way
              // first.
              className="min-w-20 max-w-56 shrink"
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
        <DropdownMenuContent align="start" className="w-60">
          {currentWorkflowId ? (
            <WorkflowDescription workflowId={currentWorkflowId} />
          ) : null}
          {offers.rename ? (
            <DropdownMenuItem onClick={openRename}>
              <Pencil />
              Rename
            </DropdownMenuItem>
          ) : null}
          {offers.duplicate ? (
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
          {currentWorkflowId ? (
            <>
              <DropdownMenuSeparator />
              {/* The id is what a support conversation asks for. The row
                  copies it without printing it, the way the workflows page's
                  row menu does, so a 36-character id stays out of the
                  default view. */}
              <DropdownMenuItem
                onClick={() => void copyWorkflowId(currentWorkflowId)}
              >
                <Copy />
                Copy workflow ID
              </DropdownMenuItem>
            </>
          ) : null}
          {offers.delete ? (
            <DropdownMenuItem
              onClick={actions.handleDeleteWorkflow}
              variant="destructive"
            >
              <Trash2 />
              Delete workflow
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameWorkflowDialog
        key={`rename-${renameDialog.session}`}
        currentName={state.workflowName}
        otherWorkflowNames={otherWorkflowNames}
        onOpenChange={(open) =>
          setRenameDialog((current) => ({ ...current, open }))
        }
        open={renameDialog.open}
      />
    </>
  );
}
