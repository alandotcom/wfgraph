import { type NodeProps, Position } from "@xyflow/react";
import { Play } from "lucide-react";
import { memo } from "react";
import {
  Node,
  NodeDescription,
  NodeTitle,
} from "#src/components/flow-elements/node";
import { workflowNodeClassName } from "#src/components/workflow/workflow-node-dimensions";
import { cn } from "@wfgraph/shared/utils";
import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
} from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import type { WorkflowNodeData } from "#src/lib/workflow-graph-types";
import {
  configDeclaresCancelEvent,
  manualStartAllowed,
  readLifecycleRules,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";

// Two bottom handles split left/right rather than stacked, so both stay
// reachable for a drag, and each carries a label chip centred on it.
//
// The percentages are of this card's own 192px width (`w-48` below). A
// quarter either side of centre gives the two chips 96px, which they need
// because both labels together are wider than a tighter 38/62 split.
const STARTED_HANDLE_LEFT = "25%";
const CANCELED_HANDLE_LEFT = "75%";

type LifecycleNodeProps = NodeProps & {
  data?: WorkflowNodeData;
};

/**
 * What the node says starts a run.
 *
 * Absent rules are answered by `manualStartAllowed`, which is the same function
 * the execute route is held to: a workflow the Lifecycle panel has never touched is
 * one the Run button starts, and saying otherwise on the canvas contradicted the
 * button beside it.
 */
export function getStartSummary(config: WorkflowNodeData["config"]): string {
  const rules = readLifecycleRules(config);

  if (rules?.startEvents.length) {
    return `On ${rules.startEvents.join(", ")}`;
  }

  return manualStartAllowed(rules)
    ? "Manual runs only"
    : "Nothing starts this yet";
}

export const LifecycleNode = memo(({ data, selected }: LifecycleNodeProps) => {
  if (!data) {
    return null;
  }

  const displayTitle = data.label || "Lifecycle";
  const startSummary = getStartSummary(data.config);
  const displayDescription = data.description || startSummary;
  const status = data.status;
  // Soften the chip when no Cancel Event can take this outlet; the handle stays
  // connectable so a builder can still wire the branch before naming Events.
  const canceledInactive = !configDeclaresCancelEvent(data.config);

  return (
    <Node
      className={cn(workflowNodeClassName, selected && "border-primary")}
      handles={{
        target: false,
        source: [
          {
            id: LIFECYCLE_STARTED_HANDLE,
            position: Position.Bottom,
            style: { left: STARTED_HANDLE_LEFT, width: 12, height: 12 },
          },
          {
            id: LIFECYCLE_CANCELED_HANDLE,
            position: Position.Bottom,
            style: {
              left: CANCELED_HANDLE_LEFT,
              width: 12,
              height: 12,
              ...(canceledInactive ? { opacity: 0.45 } : {}),
            },
          },
        ],
      }}
      status={status}
    >
      <div
        className="pointer-events-none absolute -bottom-8 -translate-x-1/2 rounded-sm border bg-card px-1.5 py-0.5 text-xs text-muted-foreground leading-none"
        style={{ left: STARTED_HANDLE_LEFT }}
      >
        Started
      </div>
      <div
        className={cn(
          "pointer-events-none absolute -bottom-8 -translate-x-1/2 rounded-sm border bg-card px-1.5 py-0.5 text-xs text-muted-foreground leading-none",
          canceledInactive && "opacity-50"
        )}
        style={{ left: CANCELED_HANDLE_LEFT }}
      >
        Canceled
      </div>

      <div className="flex w-full flex-col items-center justify-center gap-1.5 px-3 py-2">
        <Play className="size-8 text-node-lifecycle" strokeWidth={1.5} />
        <div className="flex w-full min-w-0 flex-col items-center gap-0.5 text-center">
          <NodeTitle className="w-full truncate text-base">
            {displayTitle}
          </NodeTitle>
          {displayDescription && (
            <NodeDescription className="w-full truncate text-xs">
              {displayDescription}
            </NodeDescription>
          )}
        </div>
      </div>
    </Node>
  );
});

LifecycleNode.displayName = "LifecycleNode";
