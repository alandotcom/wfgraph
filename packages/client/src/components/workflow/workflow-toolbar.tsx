import { Separator } from "#src/components/ui/separator";
import { UserMenu } from "#src/components/workflows/user-menu";
import {
  DashboardLink,
  DuplicateButton,
  ToolbarActions,
  WorkflowMenuComponent,
} from "#src/components/workflow/workflow-toolbar-chrome";
import {
  useWorkflowActions,
  useWorkflowState,
} from "#src/components/workflow/workflow-toolbar-handlers";

type WorkflowToolbarProps = {
  workflowId?: string;
};

export const WorkflowToolbar = ({ workflowId }: WorkflowToolbarProps) => {
  const state = useWorkflowState();
  const actions = useWorkflowActions(state);

  return (
    // The query container is this wrapper rather than the bar itself. An
    // element is never its own container, so the three `@xl:` classes the old
    // row carried beside its own `@container` never matched at any width and it
    // stayed in its stacked two-line form on every screen. Its descendants'
    // `@xl:` classes did resolve against it, which is why the labels inside
    // appeared and disappeared as expected; only the row's own did not.
    <div className="@container shrink-0">
      {/* One line, one height, at every width. This bar is a `shrink-0`
          sibling of the canvas box, so every pixel it gains comes out of React
          Flow's height and React Flow measures the change: nothing in here may
          wrap or grow. A canvas too narrow to hold the row scrolls it sideways
          instead, with the scrollbar hidden because a classic one would eat a
          quarter of the height.

          Packed left, and nothing reports state: mode, publication, save and
          the issue count all belong to the status strip under the canvas. */}
      <div className="flex h-11 items-center gap-2 overflow-x-auto border-b bg-background px-2.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
        {/* Nothing for a non-owner: they get the duplicate path below instead. */}
        <ToolbarActions
          actions={actions}
          state={state}
          workflowId={workflowId}
        />
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
        {/* Last rather than right-aligned, and kept here because this menu is
            the only way to reach Connections, API keys and the theme from
            anywhere in the app. */}
        <UserMenu />
      </div>
    </div>
  );
};
