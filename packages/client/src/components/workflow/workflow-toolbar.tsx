import { Separator } from "#src/components/ui/separator";
import { Button } from "#src/components/ui/button";
import { ButtonGroup } from "#src/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#src/components/ui/dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { useAtomValue } from "jotai";
import { Menubar } from "@base-ui/react/menubar";
import { UserMenu } from "#src/components/workflows/user-menu";
import {
  DashboardLink,
  CommandPaletteTrigger,
  RunPublishMenuItems,
  ToolbarActions,
  ToolbarPublishControls,
  WorkflowMenuComponent,
} from "#src/components/workflow/workflow-toolbar-chrome";
import { useWorkflowActions } from "#src/components/workflow/workflow-toolbar-handlers";
import { useWorkflowToolbarState } from "#src/components/workflow/workflow-toolbar-state";
import { useWorkflowComparisonActions } from "#src/components/workflow/use-workflow-comparison-actions";
import { useWorkflowWorkspaceNavigation } from "#src/hooks/use-workflow-workspace-navigation";
import {
  type WorkflowWorkspaceView,
  workflowWorkspaceViewAtom,
} from "#src/lib/workflow-ui-store";

type WorkflowToolbarProps = {
  workflowId?: string | undefined;
};

const WORKSPACE_LABELS: Record<WorkflowWorkspaceView, string> = {
  draft: "Draft",
  runs: "Runs",
  changes: "Changes",
};

function isWorkspaceView(value: unknown): value is WorkflowWorkspaceView {
  return value === "draft" || value === "runs" || value === "changes";
}

/**
 * Which views this workflow offers, which one is on screen, and how to switch.
 * The desktop switcher and the mobile overflow menu render the same choice, so
 * the trailing group reads this once.
 *
 * An unsaved canvas offers no views, because Runs and Changes both need a saved
 * workflow and there is no second view to switch to.
 */
function useWorkspaceViews({
  hasWorkflow,
  canReadRuns,
  canCompare,
  canReadVersionHistory,
  isPublished,
}: {
  hasWorkflow: boolean;
  canReadRuns: boolean;
  canCompare: boolean;
  canReadVersionHistory: boolean;
  isPublished: boolean;
}) {
  const view = useAtomValue(workflowWorkspaceViewAtom);
  const comparisonActions = useWorkflowComparisonActions();
  const navigation = useWorkflowWorkspaceNavigation(
    comparisonActions.openComparison
  );
  const views: WorkflowWorkspaceView[] = hasWorkflow
    ? [
        "draft",
        ...(canReadRuns ? (["runs"] as const) : []),
        ...(canReadVersionHistory && canCompare && isPublished
          ? (["changes"] as const)
          : []),
      ]
    : [];
  const selectView = (nextView: WorkflowWorkspaceView) => {
    if (nextView === "draft") navigation.showDraft();
    if (nextView === "runs") navigation.showRuns();
    if (nextView === "changes") navigation.showChanges();
  };

  return { view, views, selectView };
}

/** The three views as a segmented control, at `md` and above. */
function WorkspaceViewSwitcher({
  view,
  views,
  selectView,
}: ReturnType<typeof useWorkspaceViews>) {
  return (
    <ButtonGroup
      aria-label="Workspace view"
      className="hidden rounded-md bg-muted p-0.5 md:flex"
    >
      {views.map((item) => (
        <Button
          aria-pressed={view === item}
          className="h-6 border-0 px-2 shadow-none"
          key={item}
          onClick={() => selectView(item)}
          size="sm"
          type="button"
          variant={view === item ? "default" : "ghost"}
        >
          {WORKSPACE_LABELS[item]}
        </Button>
      ))}
    </ButtonGroup>
  );
}

/**
 * The whole trailing group as one button, below `md`.
 *
 * A phone fits either the view switcher or a run command, and a scrolling row
 * hides whichever does not fit. The four controls become four menu rows: the
 * current view, the two run commands, and Publish. Each row is disabled for the
 * same reason its desktop control is.
 */
function WorkflowActionsMenu({
  actions,
  state,
  view,
  views,
  selectView,
}: ReturnType<typeof useWorkspaceViews> & {
  actions: ReturnType<typeof useWorkflowActions>;
  state: ReturnType<typeof useWorkflowToolbarState>;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label="Workflow actions"
            className="shrink-0 md:hidden"
            size="icon"
            variant="outline"
          />
        }
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      {/* This trigger is the overflow button in the trailing group, which sits
          against the shell's right edge. A 14rem menu aligned to the end of it
          stays on screen at phone width without a collision shift. */}
      <DropdownMenuContent align="end" className="w-56">
        {/* One view is not a choice: the reader is already looking at it, and a
            radio group of one row offers nothing to move to. */}
        {views.length > 1 ? (
          <>
            <DropdownMenuRadioGroup
              onValueChange={(value) => {
                if (isWorkspaceView(value) && views.includes(value)) {
                  selectView(value);
                }
              }}
              value={view}
            >
              {views.map((item) => (
                <DropdownMenuRadioItem key={item} value={item}>
                  {WORKSPACE_LABELS[item]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {state.canExecute || state.canPublish ? (
              <DropdownMenuSeparator />
            ) : null}
          </>
        ) : null}
        {state.canExecute || state.canPublish ? (
          <RunPublishMenuItems actions={actions} state={state} />
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The trailing group: the view switcher, then the controls that write.
 *
 * The views come from the saved workflow, so an unsaved canvas drops the
 * switcher. Run and Publish stay, because an unsaved canvas can still run and
 * still publish.
 */
function WorkflowTrailingControls({
  actions,
  state,
  workflowId,
}: WorkflowToolbarProps & {
  actions: ReturnType<typeof useWorkflowActions>;
  state: ReturnType<typeof useWorkflowToolbarState>;
}) {
  const workspace = useWorkspaceViews({
    hasWorkflow: Boolean(workflowId),
    canReadRuns: state.canReadRuns,
    canCompare: state.canCompare,
    canReadVersionHistory: state.canReadVersionHistory,
    isPublished: Boolean(state.publication?.isPublished),
  });
  // Below `md` the whole group is one button. A viewer who does not own the
  // workflow can neither run nor publish, and their only view is already on
  // screen, so the button would open an empty menu. Hide it instead.
  const hasOverflowRows =
    state.canExecute || state.canPublish || workspace.views.length > 1;

  return (
    <>
      {workspace.views.length > 0 ? (
        <WorkspaceViewSwitcher {...workspace} />
      ) : null}
      <ToolbarPublishControls actions={actions} state={state} />
      {hasOverflowRows ? (
        <WorkflowActionsMenu {...workspace} actions={actions} state={state} />
      ) : null}
    </>
  );
}

/** Places the editor's navigation, palette, and write controls in one fixed row. */
export function WorkflowToolbarChrome({
  actions,
  state,
  workflowId,
}: WorkflowToolbarProps & {
  actions: ReturnType<typeof useWorkflowActions>;
  state: ReturnType<typeof useWorkflowToolbarState>;
}) {
  return (
    <div className="relative h-11 shrink-0 border-b bg-background">
      {/* The row remains one fixed height. A narrow editor can scroll through
          every control while the palette trigger remains centred in this toolbar
          container at desktop widths. */}
      <div className="flex h-11 items-center gap-2 overflow-x-auto px-2.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <Menubar
          className="flex min-w-max items-center gap-2 min-[70rem]:min-w-0 min-[70rem]:max-w-[calc(50%-10rem)] min-[70rem]:flex-1 min-[70rem]:overflow-x-auto min-[70rem]:overscroll-contain"
          data-slot="workflow-toolbar-left"
        >
          <DashboardLink />
          <Separator
            className="data-vertical:h-4 data-vertical:self-center"
            orientation="vertical"
          />
          <WorkflowMenuComponent
            actions={actions}
            state={state}
            workflowId={workflowId}
          />
          <ToolbarActions actions={actions} state={state} />
          <UserMenu />
        </Menubar>
        {/* Centred by its own absolute box, and written here rather than after
            the trailing group so Tab reaches it where the eye finds it: between
            the two groups it sits between. */}
        <div className="pointer-events-none absolute inset-x-0 top-2 hidden justify-center min-[70rem]:flex">
          <div className="pointer-events-auto">
            <CommandPaletteTrigger />
          </div>
        </div>
        {/* Sticky against the right edge, because this row scrolls: a phone
            cannot fit the leading menus and these controls at once, and the
            group that writes is the one that must never be the half scrolled
            out of reach. It is opaque for the same reason. */}
        <div
          className="sticky right-0 z-10 ml-auto flex min-w-max items-center gap-2 bg-background pl-2 before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-4 before:bg-gradient-to-l before:from-background min-[70rem]:before:hidden min-[70rem]:min-w-0 min-[70rem]:max-w-[calc(50%-10rem)] min-[70rem]:flex-1 min-[70rem]:justify-end min-[70rem]:overflow-x-auto min-[70rem]:overscroll-contain"
          data-slot="workflow-toolbar-right"
        >
          <WorkflowTrailingControls
            actions={actions}
            state={state}
            workflowId={workflowId}
          />
        </div>
      </div>
    </div>
  );
}

export const WorkflowToolbar = ({ workflowId }: WorkflowToolbarProps) => {
  const state = useWorkflowToolbarState();
  const actions = useWorkflowActions(state);

  return (
    <WorkflowToolbarChrome
      actions={actions}
      state={state}
      workflowId={workflowId}
    />
  );
};
