import {
  Handle,
  type NodeProps,
  Position,
  useUpdateNodeInternals,
} from "@xyflow/react";
import { useAtomValue } from "jotai";
import { ArrowRight, Group } from "lucide-react";
import { memo, useMemo } from "react";
import { cn } from "@wfgraph/shared/utils";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import { useAfterPaint } from "#src/hooks/effects";
import {
  groupMemberCountAtom,
  groupOutletHandlesAtom,
} from "#src/lib/workflow-graph-presentation-store";
import {
  COMPARISON_NODE_ANNOTATION,
  type WorkflowNodeData,
} from "#src/lib/workflow-graph-types";
import { NODE_ICON_CLASS } from "#src/lib/workflow-node-dimensions";
import { ComparisonMarker } from "#src/components/flow-elements/comparison-marker";
import { NodeIssueBadge } from "#src/components/flow-elements/node-issue-badge";
import { Button } from "#src/components/ui/button";
import { useGroupScopeNavigation } from "#src/components/workflow/use-group-scope-navigation";

type GroupNodeProps = NodeProps & {
  data?: WorkflowNodeData;
  id: string;
};

/**
 * A Group on the overview: one collapsed card naming the Group and how many
 * steps it holds. Its members show only on the focused Group canvas, which the
 * card's Enter group button opens.
 */
export const GroupNode = memo(({ data, selected, id }: GroupNodeProps) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const { enterGroup } = useGroupScopeNavigation();
  // The canvas paints each edge leaving a Group as leaving its frame, keeping
  // the member's source handle. React Flow draws such an edge only from a
  // handle with that id, so the frame draws one handle per distinct handle its
  // continuation edges name.
  const outletHandles = useAtomValue(
    useMemo(() => groupOutletHandlesAtom(id), [id])
  );
  const memberCount = useAtomValue(
    useMemo(() => groupMemberCountAtom(id), [id])
  );
  // React Flow records handle ids when it measures a node, so a changed set of
  // ids has to be measured again before an edge can attach to a new one.
  useAfterPaint(outletHandles, () => {
    updateNodeInternals(id);
  });

  if (!data || !isGroupNode({ data })) {
    return null;
  }
  const label = data.label || "Group";

  return (
    <div
      className={cn(
        // Graphite Wash behind the Canvas Line border marks the one container
        // on the canvas, and the rule under the title separates its chrome
        // from the summary below.
        "relative flex h-full w-full flex-col rounded-md border-[1.5px] border-canvas-line bg-muted shadow-none",
        "group-node-container"
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
      <div className="flex h-9 shrink-0 items-center gap-2 border-canvas-line/60 border-b pr-1 pl-3 font-medium text-sm">
        <Group
          className={cn(NODE_ICON_CLASS, "shrink-0 text-muted-foreground")}
          strokeWidth={1.5}
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {/* The badge counts the Group rules' issues and each member's, since
            the card hides its members. It shows whatever the members' enabled
            states are, because publication judges every Group. */}
        <NodeIssueBadge issues={data.issues} placement="inline" />
        <Button
          aria-label={`Enter group ${label}`}
          // `nodrag` keeps a press on the button from starting a drag or
          // selecting the card underneath it.
          className="nodrag nopan"
          onClick={(event) => {
            event.stopPropagation();
            enterGroup(id);
          }}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <ArrowRight />
        </Button>
      </div>
      <dl className="flex flex-1 items-center justify-between px-3 text-xs">
        <dt className="text-muted-foreground">Steps</dt>
        <dd className="font-medium tabular-nums">{memberCount}</dd>
      </dl>
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
