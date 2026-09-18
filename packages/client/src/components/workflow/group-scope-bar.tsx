import { useAtomValue, useAtomValueRawSync } from "jotai";
import { ArrowLeft } from "lucide-react";
import { useMemo, useRef } from "react";
import { Button } from "#src/components/ui/button";
import { useAfterCommit } from "#src/hooks/effects";
import { presentedGraphAtom } from "#src/lib/workflow-graph-store";
import { groupMemberCountAtom } from "#src/lib/workflow-graph-presentation-store";
import { scopeGroupLabel } from "#src/lib/workflow-graph-types";
import { currentWorkflowNameAtom } from "#src/lib/workflow-save-store";
import { activeWorkspaceAddressAtom } from "#src/lib/workflow-workspace-navigation";
import { CANVAS_OBSTACLE_SLOTS } from "./canvas-reveal/reveal-geometry";
import { useGroupScopeNavigation } from "./use-group-scope-navigation";

/**
 * The navigation path of a focused Group canvas: a Workflow button that returns
 * to the overview, the workflow and Group names, and the Group's step count.
 * Renders nothing on the overview. Entering a Group moves DOM focus to the
 * Workflow button when the control that entered it is gone.
 */
export function GroupScopeBar() {
  // Workspace synchronization can write the scope before subscriptions mount.
  const { scope } = useAtomValueRawSync(activeWorkspaceAddressAtom);
  const graph = useAtomValue(presentedGraphAtom);
  const workflowName = useAtomValue(currentWorkflowNameAtom);
  const { leaveGroup } = useGroupScopeNavigation();
  const leaveRef = useRef<HTMLButtonElement>(null);
  const groupId = scope.kind === "group" ? scope.groupId : null;
  const label = scopeGroupLabel(graph?.nodes ?? [], scope);
  const count = useAtomValue(
    useMemo(() => groupMemberCountAtom(groupId ?? ""), [groupId])
  );

  useAfterCommit(label === null ? null : groupId, () => {
    if (
      label !== null &&
      (document.activeElement === null ||
        document.activeElement === document.body)
    ) {
      leaveRef.current?.focus();
    }
  });

  if (label === null) {
    return null;
  }

  return (
    <nav
      aria-label="Group"
      className="nokey absolute top-3 left-3 z-10 flex max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-lg border bg-background py-1 pr-3 pl-1 text-xs shadow-sm"
      data-slot={CANVAS_OBSTACLE_SLOTS.groupScopeBar}
    >
      <Button
        // A finger's 44px target below `md`, where the button is the way out
        // of the Group.
        className="max-md:h-11 max-md:px-3"
        onClick={leaveGroup}
        ref={leaveRef}
        size="sm"
        type="button"
        variant="outline"
      >
        <ArrowLeft />
        Workflow
      </Button>
      <ol className="flex min-w-0 items-center gap-1.5">
        <li className="min-w-0 truncate text-muted-foreground">
          {workflowName || "Untitled workflow"}
        </li>
        <li aria-hidden className="text-muted-foreground">
          ›
        </li>
        <li aria-current="page" className="min-w-0 truncate font-medium">
          {label}
        </li>
      </ol>
      <span className="shrink-0 text-muted-foreground">
        {count} {count === 1 ? "step" : "steps"}
      </span>
    </nav>
  );
}
