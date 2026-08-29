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
  DuplicateButton,
  CommandPaletteTrigger,
  RunPublishMenuItems,
  ToolbarActions,
  ToolbarPublishControls,
  WorkflowMenuComponent,
} from "#src/components/workflow/workflow-toolbar-chrome";
import {
  useWorkflowActions,
  useWorkflowState,
} from "#src/components/workflow/workflow-toolbar-handlers";
import { useWorkflowComparisonActions } from "#src/components/workflow/use-workflow-comparison-actions";
import { useWorkflowWorkspaceNavigation } from "#src/hooks/use-workflow-workspace-navigation";
import {
  type WorkflowWorkspaceView,
  workflowWorkspaceViewAtom,
} from "#src/lib/workflow-ui-store";

type WorkflowToolbarProps = {
  workflowId?: string;
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
 * Which views this workflow offers, which one is on screen, and how to move
 * between them. Read once for the trailing group, because the desktop switcher
 * and the mobile overflow menu are two renderings of the same choice.
 *
 * A canvas nobody has saved yet offers none of them: Runs and Changes are read
 * off a workflow that exists, and there is no second view to switch to.
 */
function useWorkspaceViews({
  hasWorkflow,
  isOwner,
  isPublished,
}: {
  hasWorkflow: boolean;
  isOwner: boolean;
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
        ...(isOwner ? (["runs"] as const) : []),
        ...(isOwner && isPublished ? (["changes"] as const) : []),
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
 * The whole trailing group, as one button, below `md`.
 *
 * A phone has room for a switcher or a Run verb, never both, and a row that
 * scrolls hides whichever it cannot fit. So the four controls become four rows
 * behind one trigger: which view is on screen, then the two Run verbs and
 * Publish, each refused for the same reason it is refused on the desktop.
 */
function WorkflowActionsMenu({
  actions,
  state,
  view,
  views,
  selectView,
}: ReturnType<typeof useWorkspaceViews> & {
  actions: ReturnType<typeof useWorkflowActions>;
  state: ReturnType<typeof useWorkflowState>;
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
            {state.isOwner ? <DropdownMenuSeparator /> : null}
          </>
        ) : null}
        {state.isOwner ? (
          <RunPublishMenuItems actions={actions} state={state} />
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The trailing group: which view is on screen, then what a press writes.
 *
 * The views come from the workflow, so an unsaved canvas has none and the
 * switcher goes with them. Run and Publish stay, because a canvas nobody has
 * saved yet still runs and still publishes.
 */
function WorkflowTrailingControls({
  actions,
  state,
  workflowId,
}: WorkflowToolbarProps & {
  actions: ReturnType<typeof useWorkflowActions>;
  state: ReturnType<typeof useWorkflowState>;
}) {
  const workspace = useWorkspaceViews({
    hasWorkflow: Boolean(workflowId),
    isOwner: state.isOwner,
    isPublished: Boolean(state.publication?.isPublished),
  });
  // Below `md` the whole group is one button, and a button that opens onto
  // nothing is worse than no button: a non-owner can neither run nor publish,
  // and the single view they have is the one already on screen.
  const hasOverflowRows = state.isOwner || workspace.views.length > 1;

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
  state: ReturnType<typeof useWorkflowState>;
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
          <ToolbarActions
            actions={actions}
            state={state}
            workflowId={workflowId}
          />
          <UserMenu />
          {workflowId && !state.isOwner && (
            <>
              <span className="shrink-0 whitespace-nowrap text-muted-foreground text-xs">
                Read-only
              </span>
              <DuplicateButton
                isDuplicating={actions.isDuplicating}
                onDuplicate={actions.handleDuplicate}
              />
            </>
          )}
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
  const state = useWorkflowState();
  const actions = useWorkflowActions(state);

  return (
    <WorkflowToolbarChrome
      actions={actions}
      state={state}
      workflowId={workflowId}
    />
  );
};
