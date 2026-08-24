import { Separator } from "#src/components/ui/separator";
import { Button } from "#src/components/ui/button";
import { ButtonGroup } from "#src/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "#src/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";
import { useAtomValue } from "jotai";
import { UserMenu } from "#src/components/workflows/user-menu";
import {
  DashboardLink,
  DuplicateButton,
  CommandPaletteTrigger,
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

function WorkflowWorkspaceSwitcher({
  isOwner,
  isPublished,
}: {
  isOwner: boolean;
  isPublished: boolean;
}) {
  const view = useAtomValue(workflowWorkspaceViewAtom);
  const comparisonActions = useWorkflowComparisonActions();
  const navigation = useWorkflowWorkspaceNavigation(
    comparisonActions.openComparison
  );
  const views: WorkflowWorkspaceView[] = [
    "draft",
    ...(isOwner ? (["runs"] as const) : []),
    ...(isOwner && isPublished ? (["changes"] as const) : []),
  ];
  const selectView = (nextView: WorkflowWorkspaceView) => {
    if (nextView === "draft") navigation.showDraft();
    if (nextView === "runs") navigation.showRuns();
    if (nextView === "changes") navigation.showChanges();
  };

  return (
    <>
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
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button className="md:hidden" size="default" variant="secondary" />
          }
        >
          {WORKSPACE_LABELS[view]}
          <ChevronDown className="size-3 opacity-50" data-icon="inline-end" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
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
        </DropdownMenuContent>
      </DropdownMenu>
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
        <div
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
        </div>
        <div
          className="ml-auto flex min-w-max items-center gap-2 min-[70rem]:min-w-0 min-[70rem]:max-w-[calc(50%-10rem)] min-[70rem]:flex-1 min-[70rem]:justify-end min-[70rem]:overflow-x-auto min-[70rem]:overscroll-contain"
          data-slot="workflow-toolbar-right"
        >
          {workflowId ? (
            <WorkflowWorkspaceSwitcher
              isOwner={state.isOwner}
              isPublished={Boolean(state.publication?.isPublished)}
            />
          ) : null}
          <ToolbarPublishControls actions={actions} state={state} />
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-2 hidden justify-center min-[70rem]:flex">
        <div className="pointer-events-auto">
          <CommandPaletteTrigger />
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
