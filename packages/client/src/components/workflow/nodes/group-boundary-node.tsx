import { Handle, type NodeProps, Position } from "@xyflow/react";
import { ArrowDown, ArrowRight, CircleStop } from "lucide-react";
import { memo } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import {
  GROUP_BOUNDARY_NODE_TYPES,
  GROUP_END_STUB_LABEL,
} from "#src/lib/group-scope-canvas";
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
 * which the stub reads from the handle sides it is given. Stubs cannot be
 * selected. The handle follows `isConnectable`, which React Flow derives from
 * the node's `connectable`: an ingress stub inherits the canvas's
 * `nodesConnectable`, and a continuation stub is never connectable.
 */
function GroupBoundaryNode({
  data,
  direction,
  isConnectable,
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
        isConnectable={isConnectable}
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

/**
 * A stub after the members of a focused Group marking where one path ends
 * inside it. Its one edge comes from the member outlet that nothing leaves, so
 * a Condition branch that ends reads True or False on that edge. It is never
 * selectable or connectable.
 */
const GroupEndNode = memo(
  ({
    isConnectable,
    targetPosition = Position.Top,
  }: GroupBoundaryNodeProps) => (
    <div
      className="flex h-full w-full items-center gap-2 rounded-md border border-canvas-line border-dashed bg-background px-3 text-muted-foreground text-xs"
      data-slot="group-end-stub"
    >
      <CircleStop className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate font-medium">
        {GROUP_END_STUB_LABEL}
      </span>
      <Handle
        isConnectable={isConnectable}
        position={targetPosition}
        type="target"
      />
    </div>
  )
);
GroupEndNode.displayName = "GroupEndNode";

/** The stub components, under the React Flow node types stubs are painted with. */
export const groupBoundaryNodeTypes = {
  [GROUP_BOUNDARY_NODE_TYPES.ingress]: GroupIngressNode,
  [GROUP_BOUNDARY_NODE_TYPES.continuation]: GroupContinuationNode,
  [GROUP_BOUNDARY_NODE_TYPES.end]: GroupEndNode,
};
