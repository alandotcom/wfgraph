import {
  Background,
  ReactFlow,
  type ReactFlowProps,
  useStore,
} from "@xyflow/react";
import type { ReactNode } from "react";
import { useAfterCommit } from "#src/hooks/effects";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import "@xyflow/react/dist/style.css";

// Every node on this canvas is a workflow node, so React Flow's node generic
// is pinned here. Callbacks such as onNodesChange then hand their consumers a
// WorkflowNode directly.
type CanvasProps = ReactFlowProps<WorkflowNode> & {
  children?: ReactNode;
};

/**
 * Mirrors the live canvas zoom onto the document as `--rf-zoom`.
 *
 * Handle hit areas are drawn inside `.react-flow__viewport`, which carries the
 * zoom transform, so the flat 44px touch target measured 24.6px on a phone once
 * fitView had scaled the graph down. `globals.css` divides this back out.
 * Reading the store rather than `onMove` catches the initial fitView, which is
 * exactly the case that was wrong.
 */
function ZoomPublisher() {
  const zoom = useStore((state) => state.transform[2]);

  useAfterCommit(zoom, () => {
    document.documentElement.style.setProperty("--rf-zoom", String(zoom));
  });

  return null;
}

export const Canvas = ({ children, ...props }: CanvasProps) => {
  return (
    <ReactFlow
      deleteKeyCode={["Backspace", "Delete"]}
      // Group needs a multi-select; xyflow defaults this to Meta/Control only.
      multiSelectionKeyCode={["Meta", "Control", "Shift"]}
      panActivationKeyCode={null}
      selectionOnDrag={false}
      zoomOnDoubleClick={false}
      zoomOnPinch
      {...props}
    >
      <ZoomPublisher />
      <Background
        bgColor="var(--sidebar)"
        color="var(--border)"
        gap={24}
        size={2}
      />
      {children}
    </ReactFlow>
  );
};
