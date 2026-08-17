import { Handle, type NodeProps, Position } from "@xyflow/react";
import { EyeOff } from "lucide-react";
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

  // Stamped onto the frame by `displayNodesAtom`; the members hold the flag.
  const isDisabled = data.enabled === false;

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col rounded-md border bg-muted/40 shadow-none",
        selected && "border-primary",
        isDisabled && "opacity-50"
      )}
      data-testid={`group-node-${id}`}
    >
      <Handle position={Position.Top} type="target" />
      <div className="flex h-9 shrink-0 items-center gap-2 px-3 font-medium text-sm">
        {isDisabled && (
          <span className="rounded-full bg-muted-foreground/50 p-1">
            <EyeOff className="size-3.5 text-background" />
          </span>
        )}
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
