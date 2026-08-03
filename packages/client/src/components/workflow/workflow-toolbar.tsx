import { Panel } from "#src/components/flow-elements/panel";
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
    <>
      <Panel
        className="flex flex-col gap-2 rounded-none border-none bg-transparent p-0 lg:flex-row lg:items-center"
        position="top-left"
      >
        <div className="flex items-center gap-2">
          <WorkflowMenuComponent
            actions={actions}
            state={state}
            workflowId={workflowId}
          />
          {workflowId && state.workflowMode === "test" && (
            <span className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 font-semibold text-[10px] text-destructive uppercase">
              Test Mode
            </span>
          )}
          {workflowId && !state.isOwner && (
            <span className="hidden text-muted-foreground text-xs uppercase lg:inline">
              Read-only
            </span>
          )}
        </div>
      </Panel>

      <div className="pointer-events-auto absolute top-4 right-4 z-10">
        <div className="flex flex-col-reverse items-end gap-2 lg:flex-row lg:items-center">
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
      {workflowId && state.workflowMode === "test" && (
        <div className="pointer-events-none absolute right-4 bottom-4 z-10 max-w-xl rounded border border-destructive/30 bg-destructive/10 px-4 py-2 text-xs">
          <p className="font-semibold text-destructive uppercase tracking-wide">
            Test mode active
          </p>
          <p className="font-medium text-foreground">
            No real email or SMS is sent unless a node is configured to route to
            a test recipient.
          </p>
        </div>
      )}
    </>
  );
};
