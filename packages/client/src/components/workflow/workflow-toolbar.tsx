import { Separator } from "#src/components/ui/separator";
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

type WorkflowToolbarProps = {
  workflowId?: string;
};

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
