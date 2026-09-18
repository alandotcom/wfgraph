import { useNavigate } from "@tanstack/react-router";
import type { NodeMouseHandler } from "@xyflow/react";
import { useCallback } from "react";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";

export type GroupScopeNavigation = {
  /** Show the focused canvas of `groupId` in the active workspace. */
  enterGroup: (groupId: string) => void;
  /** Return the active workspace to its overview. */
  leaveGroup: () => void;
  /** React Flow `onNodeDoubleClick`, which enters a double-clicked Group. */
  onNodeDoubleClick: NodeMouseHandler<WorkflowNode>;
};

/**
 * Enters and leaves a focused Group by writing the `group` route search value,
 * keeping the rest of the workspace address. Each write pushes a history entry,
 * so browser Back leaves a Group that was entered and Forward enters it again.
 */
export function useGroupScopeNavigation(): GroupScopeNavigation {
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  const enterGroup = useCallback(
    (groupId: string) => {
      void navigate({
        search: (previous) => ({ ...previous, group: groupId }),
      });
    },
    [navigate]
  );
  const leaveGroup = useCallback(() => {
    void navigate({
      search: ({ group: _group, ...previous }) => previous,
    });
  }, [navigate]);
  const onNodeDoubleClick = useCallback<NodeMouseHandler<WorkflowNode>>(
    (_event, node) => {
      if (isGroupNode(node)) {
        enterGroup(node.id);
      }
    },
    [enterGroup]
  );
  return { enterGroup, leaveGroup, onNodeDoubleClick };
}
