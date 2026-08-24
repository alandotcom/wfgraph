import { Handle, type NodeProps, Position } from "@xyflow/react";
import { EyeOff } from "lucide-react";
import { memo } from "react";
import { cn } from "@wfgraph/shared/utils";
import {
  groupOutletHandle,
  isGroupNode,
} from "@wfgraph/shared/graph/node-group";
import {
  COMPARISON_NODE_ANNOTATION,
  type WorkflowNodeData,
} from "#src/lib/workflow-graph-types";
import { ComparisonMarker } from "#src/components/flow-elements/comparison-marker";

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
        // A solid fill, not the old `bg-muted/40`: 40% of oklch(0.97) over the
        // Paper canvas lands near oklch(0.988), which is why the frame read as
        // transparent. Solid `--muted` gives the canvas three tones to order --
        // Paper canvas, recessed frame, Paper member cards -- and it inverts on
        // its own in dark, where Void, 0.15 and 0.205 stack the same way.
        "relative flex h-full w-full flex-col rounded-md border-[1.5px] border-canvas-line bg-muted shadow-none",
        "group-node-container",
        isDisabled && "opacity-50"
      )}
      data-selected={selected}
      data-testid={`group-node-${id}`}
    >
      <ComparisonMarker comparison={data[COMPARISON_NODE_ANNOTATION]} />
      <Handle
        aria-label="Group input"
        position={Position.Top}
        role="img"
        type="target"
      />
      {/* The rule under the title is what separates the frame's own chrome from
          the members below it; without it the header floats in the fill. */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-canvas-line/60 border-b px-3 font-medium text-sm">
        {isDisabled && (
          <span className="rounded-full bg-muted-foreground/50 p-1">
            <EyeOff className="size-3.5 text-background" />
          </span>
        )}
        {data.label || "Group"}
      </div>
      <Handle
        aria-label="Group output"
        id={groupOutletHandle({ data, id })}
        position={Position.Bottom}
        role="img"
        type="source"
      />
    </div>
  );
});

GroupNode.displayName = "GroupNode";
