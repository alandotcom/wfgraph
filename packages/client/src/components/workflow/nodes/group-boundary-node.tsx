import { Handle, type NodeProps, Position } from "@xyflow/react";
import { ArrowDown } from "lucide-react";
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
 * sits above the members and names a step that enters the Group; a
 * continuation stub sits below them and names the step the Group continues to.
 * Stubs are display only and cannot be selected.
 */
function GroupBoundaryNode({
  data,
  direction,
}: GroupBoundaryNodeProps & { direction: "ingress" | "continuation" }) {
  const catalog = useExtensionCatalog();
  const title = comparisonNodeTitle(data, catalog);
  return (
    <div
      className="flex h-full w-full items-center gap-2 rounded-md border border-canvas-line border-dashed bg-background px-3 text-muted-foreground text-xs"
      data-slot="group-boundary-stub"
    >
      <ArrowDown className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {direction === "ingress" ? "Incoming from " : "Continues to "}
        <span className="font-medium text-foreground">{title}</span>
      </span>
      <Handle
        isConnectable={false}
        position={direction === "ingress" ? Position.Bottom : Position.Top}
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
