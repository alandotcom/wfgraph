import type { ConnectionLineComponent } from "@xyflow/react";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";

const HALF = 0.5;

// The connection line only ever draws on the workflow canvas, so it declares
// the same node type that canvas.tsx pins. Only the four geometry props are
// read here; the node type exists so the component fits the canvas it is
// handed to.
export const Connection: ConnectionLineComponent<WorkflowNode> = ({
  fromX,
  fromY,
  toX,
  toY,
}) => (
  <g>
    <path
      className="animated"
      d={`M${fromX},${fromY} C ${fromX + (toX - fromX) * HALF},${fromY} ${fromX + (toX - fromX) * HALF},${toY} ${toX},${toY}`}
      fill="none"
      stroke="var(--color-ring)"
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
