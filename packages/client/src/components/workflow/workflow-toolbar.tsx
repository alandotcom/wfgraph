import { useQuery } from "@tanstack/react-query";
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
import { WorkflowIssuesChip } from "#src/components/workflow/workflow-issues-chip";
import { WorkflowPublicationBadge } from "#src/components/workflow/workflow-publication-badge";
import { WorkflowSaveStatus } from "#src/components/workflow/workflow-save-status";
import { workflowPublicationQueryOptions } from "#src/lib/rpc-query";

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
  // Server state: draft vs published. Seeded by the route loader's getById,
  // patched by save/publish into the same cache entry — not mirrored in jotai.
  const { data: hasUnpublishedChanges = false } = useQuery({
    ...workflowPublicationQueryOptions(workflowId ?? ""),
    enabled: Boolean(workflowId),
  });

  return (
    <>
      {/* One row spanning the canvas rather than two independent corner layers.
          The right-hand group used to be its own absolutely positioned stack, so
          at 1024px it painted over 67 of the Test Mode badge's 74px. The
          container query switches to a column on canvas width, which is the
          width this row actually has; a viewport-width `lg:` was stacking nine
          icon buttons down the middle of the graph while the viewport was still
          wide. */}
      <div className="flex flex-col items-stretch gap-2 @container @xl:flex-row @xl:items-start @xl:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
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
          {workflowId && (
            <WorkflowPublicationBadge
              hasUnpublishedChanges={hasUnpublishedChanges}
              isPublished={isPublished}
            />
          )}
          {workflowId && !state.isOwner && (
            <span className="text-muted-foreground text-xs">Read-only</span>
          )}
          {/* Both of these change width as the editor is used -- a count grows a
              digit, a save label swaps word -- so they sit last in the
              left-aligned status cluster. Between the action buttons, where they
              started, every such change reflowed the row and moved a control out
              from under the pointer. Here they grow into empty canvas and push
              nothing. */}
          {/* Last in the row because both change width as the editor is used,
              and here they grow into empty canvas rather than moving a control
              out from under the pointer. Not gated on `workflowId`, unlike the
              badges above: a canvas nobody has saved yet has the most to lose.
              Each is owner-only and checks that for itself. */}
          <WorkflowIssuesChip onOpen={actions.handleShowIssues} />
          <WorkflowSaveStatus />
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
