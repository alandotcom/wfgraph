import {
  Background,
  ReactFlow,
  type ReactFlowProps,
  useStore,
} from "@xyflow/react";
import type { ReactNode } from "react";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { useAfterCommit } from "#src/hooks/effects";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { workflowZoomPresentation } from "#src/components/workflow/workflow-viewport";
import "@xyflow/react/dist/style.css";

// Every node on this canvas is a workflow node, so React Flow's node generic
// is pinned here. Callbacks such as onNodesChange then hand their consumers a
// WorkflowNode directly.
//
// Every React Flow prop is restated as accepting `undefined`, because the
// editor withholds a handler by passing `undefined` when the canvas is locked.
// `Canvas` drops those keys before React Flow sees them. The mapped type also
// marks every prop optional, which loses nothing: `ReactFlowProps` declares no
// required member today, so the two spellings describe the same set of props.
type CanvasProps = {
  [Key in keyof ReactFlowProps<WorkflowNode>]?:
    | ReactFlowProps<WorkflowNode>[Key]
    | undefined;
} & {
  children?: ReactNode;
};

/**
 * Mirrors the live canvas zoom and its discrete presentation state onto the
 * document. Nodes use the state in CSS, so they do not each subscribe to zoom.
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
    document.documentElement.dataset.workflowZoom = workflowZoomPresentation(zoom);
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
      {...omitUndefined(props)}
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
