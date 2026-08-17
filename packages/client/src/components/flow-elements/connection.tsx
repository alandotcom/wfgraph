import type { ConnectionLineComponent } from "@xyflow/react";
import { getWorkflowEdgePath } from "#src/components/flow-elements/edge-path";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";

// The connection line only ever draws on the workflow canvas, so it declares
// the same node type that canvas.tsx pins. Geometry comes from the pointer
// and the handle it left; the node type exists so the component fits the
// canvas it is handed to.
export const Connection: ConnectionLineComponent<WorkflowNode> = ({
  fromX,
  fromY,
  fromPosition,
  toX,
  toY,
  toPosition,
}) => {
  const [path] = getWorkflowEdgePath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
  });

  return (
    <g>
      <path
        className="animated"
        d={path}
        fill="none"
        stroke="var(--color-ring)"
        strokeDasharray="5, 5"
        strokeWidth={1}
      />
      <circle
        cx={toX}
        cy={toY}
        fill="#fff"
        r={3}
        stroke="var(--color-ring)"
        strokeWidth={1}
      />
    </g>
  );
};
