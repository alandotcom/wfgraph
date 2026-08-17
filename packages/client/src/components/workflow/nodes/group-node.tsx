import { Handle, type NodeProps, Position } from "@xyflow/react";
import { memo } from "react";
import { cn } from "@wfgraph/shared/utils";
import {
  groupOutletHandle,
  isGroupNode,
} from "@wfgraph/shared/graph/node-group";
import type { WorkflowNodeData } from "#src/lib/workflow-graph-types";

type GroupNodeProps = NodeProps & {
  data?: WorkflowNodeData;
  id: string;
};

export const GroupNode = memo(({ data, selected, id }: GroupNodeProps) => {
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
      <Handle
        id={groupOutletHandle({ data, id })}
        position={Position.Bottom}
        type="source"
      />
    </div>
  );
});

GroupNode.displayName = "GroupNode";
