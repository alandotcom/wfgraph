import { Background, ReactFlow, type ReactFlowProps } from "@xyflow/react";
import type { ReactNode } from "react";
import type { WorkflowNode } from "@rova/shared/graph/types";
import "@xyflow/react/dist/style.css";

// Every node on this canvas is a workflow node, so React Flow's node generic
// is pinned here. Callbacks such as onNodesChange then hand their consumers a
// WorkflowNode directly.
type CanvasProps = ReactFlowProps<WorkflowNode> & {
  children?: ReactNode;
};

export const Canvas = ({ children, ...props }: CanvasProps) => (
  <ReactFlow
    deleteKeyCode={["Backspace", "Delete"]}
    fitView
    panActivationKeyCode={null}
    selectionOnDrag={false}
    zoomOnDoubleClick={false}
    zoomOnPinch
    {...props}
  >
    <Background
      bgColor="var(--sidebar)"
      color="var(--border)"
      gap={24}
      size={2}
    />
    {children}
  </ReactFlow>
);
