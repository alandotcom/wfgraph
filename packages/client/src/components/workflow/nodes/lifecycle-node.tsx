import { type NodeProps, Position } from "@xyflow/react";
import * as stylex from "@stylexjs/stylex";
import { Icon } from "@astryxdesign/core/Icon";
import { colorVars } from "@astryxdesign/core/theme/tokens.stylex";
import { Play } from "lucide-react";
import { memo } from "react";
import {
  Node,
  NodeBody,
  NodeDescription,
  NodeTitle,
} from "#src/components/flow-elements/node";
import { NodeIssueBadge } from "#src/components/flow-elements/node-issue-badge";
import { workflowNodeSize } from "#src/lib/workflow-node-dimensions";
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
      style={workflowNodeSize()}
      xstyle={selected ? styles.selected : undefined}
    >
      <div
        {...stylex.props(styles.outletLabel)}
        style={{ left: STARTED_HANDLE_LEFT }}
      >
        Started
      </div>
      <div
        data-inactive={canceledInactive || undefined}
        {...stylex.props(
          styles.outletLabel,
          canceledInactive && styles.inactive
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
        <Icon icon={Play} size="md" xstyle={styles.icon} />
        <NodeTitle>{displayTitle}</NodeTitle>
        {displayDescription && (
          <NodeDescription>{displayDescription}</NodeDescription>
        )}
      </NodeBody>
    </Node>
  );
});

LifecycleNode.displayName = "LifecycleNode";

const styles = stylex.create({
  selected: { borderColor: colorVars["--color-accent"] },
  inactive: { opacity: 0.5 },
  icon: { color: colorVars["--color-text-green"] },
  outletLabel: {
    backgroundColor: colorVars["--color-background-card"],
    border: `1px solid ${colorVars["--color-border"]}`,
    borderRadius: 4,
    bottom: -32,
    color: colorVars["--color-text-secondary"],
    fontSize: 12,
    lineHeight: 1,
    paddingBlock: 4,
    paddingInline: 6,
    pointerEvents: "none",
    position: "absolute",
    transform: "translateX(-50%)",
  },
});
