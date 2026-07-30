import { type NodeProps, Position } from "@xyflow/react";
import { Play } from "lucide-react";
import { memo } from "react";
import {
  Node,
  NodeDescription,
  NodeTitle,
} from "#src/components/flow-elements/node";
import { cn } from "@rova/shared/utils";
import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
} from "@rova/shared/workflow/lifecycle-outlets";
import type { WorkflowNodeData } from "@rova/shared/workflow/types";
import {
  manualStartAllowed,
  readLifecycleRules,
} from "@rova/shared/workflow/lifecycle-rules";

// Two bottom handles split left/right rather than stacked, so both stay
// reachable for a drag, and each carries a label chip centred on it.
//
// The percentages are of this card's own 192px width (`w-48` below), which is
// half the Action node's: its 38/62 split leaves 46px between the two centres,
// and the two chips together measure wider than that. A quarter either side of
// centre gives them 96px.
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
  const startEvents = rules?.startEvents ?? [];

  if (startEvents.length > 0) {
    return startEvents.length === 1
      ? `On ${startEvents[0]}`
      : `On ${startEvents.length} events`;
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
  const displayDescription = data.description || "Where a run begins";
  const startSummary = getStartSummary(data.config);
  const status = data.status;

  return (
    <Node
      className={cn(
        "flex h-48 w-48 flex-col items-center justify-center shadow-none transition-all duration-150 ease-out",
        selected && "border-primary"
      )}
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
            style: { left: CANCELED_HANDLE_LEFT, width: 12, height: 12 },
          },
        ],
      }}
      status={status}
    >
      <div
        className="pointer-events-none absolute -bottom-8 -translate-x-1/2 rounded-sm border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground leading-none"
        style={{ left: STARTED_HANDLE_LEFT }}
      >
        Started
      </div>
      <div
        className="pointer-events-none absolute -bottom-8 -translate-x-1/2 rounded-sm border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground leading-none"
        style={{ left: CANCELED_HANDLE_LEFT }}
      >
        Canceled
      </div>

      <div className="flex flex-col items-center justify-center gap-3 p-6">
        <Play className="size-12 text-blue-500" strokeWidth={1.5} />
        <div className="flex flex-col items-center gap-1 text-center">
          <NodeTitle className="text-base">{displayTitle}</NodeTitle>
          {displayDescription && (
            <NodeDescription className="text-xs">
              {displayDescription}
            </NodeDescription>
          )}
          <p className="max-w-40 text-[11px] text-muted-foreground leading-tight">
            {startSummary}
          </p>
        </div>
      </div>
    </Node>
  );
});

LifecycleNode.displayName = "LifecycleNode";
