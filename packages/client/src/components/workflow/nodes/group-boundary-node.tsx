import { Handle, type NodeProps, Position } from "@xyflow/react";
import { ArrowDown, ArrowRight } from "lucide-react";
import { memo } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { GROUP_BOUNDARY_NODE_TYPES } from "#src/lib/group-scope-canvas";
import {
  comparisonNodeTitle,
  type WorkflowNodeData,
} from "#src/lib/workflow-graph-types";

type GroupBoundaryNodeProps = NodeProps & { data: WorkflowNodeData };

/**
 * A stub on the focused Group canvas naming one outside step. An ingress stub
 * sits before the members and names a step that enters the Group; a
 * continuation stub sits after them and names the step the Group continues to.
 * "Before" is above in a vertical Group and to the left in a horizontal one,
 * which the stub reads from the handle sides it is given. Stubs are display
 * only and cannot be selected.
 */
function GroupBoundaryNode({
  data,
  direction,
  sourcePosition = Position.Bottom,
  targetPosition = Position.Top,
}: GroupBoundaryNodeProps & { direction: "ingress" | "continuation" }) {
  const Arrow = sourcePosition === Position.Right ? ArrowRight : ArrowDown;
  const catalog = useExtensionCatalog();
  const title = comparisonNodeTitle(data, catalog);
  return (
    <div
      className="flex h-full w-full items-center gap-2 rounded-md border border-canvas-line border-dashed bg-background px-3 text-muted-foreground text-xs"
      data-slot="group-boundary-stub"
    >
      <Arrow className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {direction === "ingress" ? "Incoming from " : "Continues to "}
        <span className="font-medium text-foreground">{title}</span>
      </span>
      <Handle
        isConnectable={false}
        position={direction === "ingress" ? sourcePosition : targetPosition}
        type={direction === "ingress" ? "source" : "target"}
      />
    </div>
  );
}

const GroupIngressNode = memo((props: GroupBoundaryNodeProps) => (
  <GroupBoundaryNode {...props} direction="ingress" />
));
GroupIngressNode.displayName = "GroupIngressNode";

const GroupContinuationNode = memo((props: GroupBoundaryNodeProps) => (
  <GroupBoundaryNode {...props} direction="continuation" />
));
GroupContinuationNode.displayName = "GroupContinuationNode";

/** The two stub components, under the React Flow node types stubs are painted with. */
export const groupBoundaryNodeTypes = {
  [GROUP_BOUNDARY_NODE_TYPES.ingress]: GroupIngressNode,
  [GROUP_BOUNDARY_NODE_TYPES.continuation]: GroupContinuationNode,
};
