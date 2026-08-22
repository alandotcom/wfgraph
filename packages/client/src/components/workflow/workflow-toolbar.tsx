import { UserMenu } from "#src/components/workflows/user-menu";
import {
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
    // One row spanning the canvas rather than two independent corner layers.
    // The right-hand group used to be its own absolutely positioned stack, so
    // at 1024px it painted over 67 of the Test Mode badge's 74px. The container
    // query switches to a column on canvas width, which is the width this row
    // actually has; a viewport-width `lg:` was stacking nine icon buttons down
    // the middle of the graph while the viewport was still wide.
    //
    // Everything that reports state rather than doing something has left this
    // row for the status strip at the bottom of the same column.
    <div className="flex flex-col items-stretch gap-2 @container @xl:flex-row @xl:items-start @xl:justify-between">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <WorkflowMenuComponent
          actions={actions}
          state={state}
          workflowId={workflowId}
        />
        {workflowId && !state.isOwner && (
          <span className="text-muted-foreground text-xs">Read-only</span>
        )}
      </div>

      {/* One line at every width, scrolling sideways when the canvas is too
          narrow to hold it. Wrapping put the toolbar over the graph.
          `justify-end` only once there is room: on an overflowing scroll
          container it pins content to the right and pushes the first controls
          off the left edge, where no scroll position can reach them. */}
      <div className="flex items-center gap-2 overflow-x-auto @xl:justify-end">
        <ToolbarActions
          actions={actions}
          state={state}
          workflowId={workflowId}
        />
        <div className="flex items-center gap-2">
          {workflowId && !state.isOwner && (
            <DuplicateButton
              isDuplicating={actions.isDuplicating}
              onDuplicate={actions.handleDuplicate}
            />
          )}
          <UserMenu />
        </div>
      </div>
    </div>
  );
};
