import {
  Handle,
  type NodeProps,
  Position,
  useUpdateNodeInternals,
} from "@xyflow/react";
import { useAtomValue } from "jotai";
import { EyeOff } from "lucide-react";
import { memo, useMemo } from "react";
import { cn } from "@wfgraph/shared/utils";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import { useAfterPaint } from "#src/hooks/effects";
import { groupOutletHandlesAtom } from "#src/lib/workflow-graph-presentation-store";
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
  const updateNodeInternals = useUpdateNodeInternals();
  // The canvas paints each edge leaving a Group as leaving its frame, keeping
  // the member's source handle. React Flow draws such an edge only from a
  // handle with that id, so the frame draws one handle per distinct handle its
  // continuation edges name.
  const outletHandles = useAtomValue(
    useMemo(() => groupOutletHandlesAtom(id), [id])
  );
  // React Flow records handle ids when it measures a node, so a changed set of
  // ids has to be measured again before an edge can attach to a new one.
  useAfterPaint(outletHandles, () => {
    updateNodeInternals(id);
  });

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
      {outletHandles.map((handle, index) => (
        <Handle
          aria-label="Group output"
          // React Flow's `id` prop takes a string or `null`, not `undefined`.
          id={handle}
          key={handle ?? ""}
          position={Position.Bottom}
          role="img"
          // Several handles spread evenly across the bottom edge.
          style={{
            left: `${((index + 1) / (outletHandles.length + 1)) * 100}%`,
          }}
          type="source"
        />
      ))}
    </div>
  );
});

GroupNode.displayName = "GroupNode";
