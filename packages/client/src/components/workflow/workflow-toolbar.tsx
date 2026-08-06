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

  const currentWorkflow = state.allWorkflows.find(
    (workflow) => workflow.id === state.currentWorkflowId
  );
  const isPublished = Boolean(currentWorkflow?.publishedVersionId);

  return (
    <>
      {/* One row spanning the canvas rather than two independent corner layers.
          The right-hand group used to be its own absolutely positioned stack, so
          at 1024px it painted over 67 of the Test Mode badge's 74px. The
          container query switches to a column on canvas width, which is the
          width this row actually has; a viewport-width `lg:` was stacking nine
          icon buttons down the middle of the graph while the viewport was still
          wide. */}
      <div className="pointer-events-none absolute inset-x-4 top-4 z-10 flex flex-col items-stretch gap-2 @container @xl:flex-row @xl:items-start @xl:justify-between">
        <div className="pointer-events-auto flex min-w-0 flex-wrap items-center gap-2">
          <WorkflowMenuComponent
            actions={actions}
            state={state}
            workflowId={workflowId}
          />
          {workflowId &&
            state.workflowMode === "test" && (
              // Warning rather than destructive: test mode destroys nothing, and
              // spending the failure colour here lit the failure signal before any
              // run had failed.
              <span className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1 font-medium text-warning text-xs">
                Test mode
              </span>
            )}
          {workflowId &&
            isPublished && (
              // Answers "is the draft what is running", which nothing
              // on this screen said once the publish toast faded. Worded away
              // from "Live" on purpose: that word already names the run mode two
              // controls to the right, and two meanings for it read as one
              // switch. Driven by draft-vs-published digest, not the save queue.
              <span className="rounded-md border bg-card px-2 py-1 font-medium text-muted-foreground text-xs">
                {state.hasUnpublishedChanges
                  ? "Unpublished changes"
                  : "Published"}
              </span>
            )}
          {workflowId && !isPublished && (
            <span className="rounded-md border bg-card px-2 py-1 font-medium text-muted-foreground text-xs">
              Never published
            </span>
          )}
          {workflowId && !state.isOwner && (
            <span className="text-muted-foreground text-xs">Read-only</span>
          )}
        </div>

        {/* One line at every width, scrolling sideways when the canvas is too
            narrow to hold it. Wrapping put the toolbar over the graph.
            `justify-end` only once there is room: on an overflowing scroll
            container it pins content to the right and pushes the first controls
            off the left edge, where no scroll position can reach them. */}
        <div className="pointer-events-auto flex items-center gap-2 overflow-x-auto @xl:justify-end">
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
      {workflowId &&
        state.workflowMode === "test" && (
          // Bottom-centre, so it stops sharing the bottom-right corner with the
          // minimap; the two overlapped by 199x50px.
          <div className="-translate-x-1/2 pointer-events-none absolute bottom-4 left-1/2 z-10 max-w-xl rounded-md border border-warning/30 bg-warning/10 px-4 py-2 text-xs">
            <p className="font-medium text-warning">Test mode active</p>
            <p className="font-medium text-foreground">
              No real email or SMS is sent unless a node is configured to route
              to a test recipient.
            </p>
          </div>
        )}
    </>
  );
};
