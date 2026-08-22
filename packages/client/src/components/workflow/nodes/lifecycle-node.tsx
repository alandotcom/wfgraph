import { type NodeProps, Position } from "@xyflow/react";
import { Play } from "lucide-react";
import { memo } from "react";
import {
  Node,
  NodeBody,
  NodeDescription,
  NodeTitle,
} from "#src/components/flow-elements/node";
import { NodeIssueBadge } from "#src/components/flow-elements/node-issue-badge";
import {
  NODE_ICON_CLASS,
  workflowNodeSize,
} from "#src/lib/workflow-node-dimensions";
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
// The percentages are of this card's own 192px width. A quarter either side
// of centre gives the two chips 96px, which they need because both labels
// together are wider than a tighter 38/62 split.
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
      handles={{
        target: false,
        source: [
          {
            id: LIFECYCLE_STARTED_HANDLE,
            label: "Started outlet",
            position: Position.Bottom,
            style: { left: STARTED_HANDLE_LEFT, width: 12, height: 12 },
          },
          {
            id: LIFECYCLE_CANCELED_HANDLE,
            label: "Canceled outlet",
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
      selected={selected}
      status={status}
      style={workflowNodeSize()}
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

      {/* The collector walks every node, not only actions: a broken template
          token in the Lifecycle config is an issue the toolbar counts, and
          without this it was one no card on the canvas admitted to. */}
      <NodeIssueBadge issues={data.issues} />

      <NodeBody>
        <Play
          className={cn(NODE_ICON_CLASS, "text-node-lifecycle")}
          strokeWidth={1.5}
        />
        <NodeTitle>{displayTitle}</NodeTitle>
        {displayDescription && (
          <NodeDescription>{displayDescription}</NodeDescription>
        )}
      </NodeBody>
    </Node>
  );
});

LifecycleNode.displayName = "LifecycleNode";
