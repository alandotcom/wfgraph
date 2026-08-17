import { Handle, type NodeProps, Position } from "@xyflow/react";
import { useAtomValue } from "jotai";
import { memo } from "react";
import { cn } from "@wfgraph/shared/utils";
import { isConditionNode } from "@wfgraph/shared/graph/node-config";
import { groupExitId, isGroupNode } from "@wfgraph/shared/graph/node-group";
import type { WorkflowNodeData } from "#src/lib/workflow-graph-types";
import { displayNodesAtom } from "#src/lib/workflow-graph-store";

type GroupNodeProps = NodeProps & {
  data?: WorkflowNodeData;
  id: string;
};

export const GroupNode = memo(({ data, selected, id }: GroupNodeProps) => {
  const nodes = useAtomValue(displayNodesAtom);
  const frame = nodes.find((node) => node.id === id);
  const exit = nodes.find((node) => node.id === groupExitId(frame));
  const sourceHandleId = isConditionNode(exit) ? "true" : undefined;

  if (!data || !isGroupNode({ data })) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col rounded-md border bg-muted/40 shadow-none",
        selected && "border-primary"
      )}
      data-testid={`group-node-${id}`}
    >
      <Handle position={Position.Top} type="target" />
      <div className="flex h-9 shrink-0 items-center px-3 font-medium text-sm">
        {data.label || "Group"}
      </div>
      <Handle id={sourceHandleId} position={Position.Bottom} type="source" />
    </div>
  );
});

GroupNode.displayName = "GroupNode";
