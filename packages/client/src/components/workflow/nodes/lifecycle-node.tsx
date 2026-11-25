import { type NodeProps, Position } from "@xyflow/react";
import { Play } from "lucide-react";
import { memo } from "react";
import {
  LEAD_GLYPH_CLASS,
  Node,
  NodeContent,
  NodeDescription,
  useCardTier,
} from "#src/components/flow-elements/node";
import { NodeIssueBadge } from "#src/components/flow-elements/node-issue-badge";
import { ComparisonMarker } from "#src/components/flow-elements/comparison-marker";
import { useReviewEdit } from "#src/components/workflow/review/use-review-edit";
import { workflowNodeSize } from "#src/lib/workflow-node-dimensions";
import { cn } from "@wfgraph/shared/utils";
import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
} from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import {
  COMPARISON_NODE_ANNOTATION,
  type WorkflowNodeData,
} from "#src/lib/workflow-graph-types";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { configDeclaresCancelEvent } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { getStartSummary } from "./lifecycle-node-summary";

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

export const LifecycleNode = memo(
  ({ id, data, selected, isConnectable }: LifecycleNodeProps) => {
    const catalog = useExtensionCatalog();
    // While the review sheet is open a changed card says what changed in the
    // words the sheet uses.
    const reviewEdit = useReviewEdit(id);
    // The Play glyph leads the card where a step's glyph and number lead
    // theirs. Zoomed out the card drops its description, and further out its
    // title.
    const tier = useCardTier();
    const isCompact = tier !== "full";

    if (!data) {
      return null;
    }

    const displayTitle = data.label || "Lifecycle";
    const startSummary = getStartSummary(data.config, catalog);
    const displayDescription =
      reviewEdit?.summary ?? (data.description || startSummary);
    const status = data.status;
    // Soften the chip when no Cancel Event can take this outlet; the handle stays
    // connectable so a builder can still wire the branch before naming Events.
    const canceledInactive = !configDeclaresCancelEvent(data.config);

    return (
      <Node
        compact={isCompact}
        data-card-form={tier}
        isConnectable={isConnectable}
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
                opacity: canceledInactive ? 0.45 : undefined,
              },
            },
          ],
        }}
        selected={selected}
        status={status}
        style={workflowNodeSize()}
      >
        <ComparisonMarker
          comparison={
            data[COMPARISON_NODE_ANNOTATION] ??
            (reviewEdit ? { kind: reviewEdit.kind } : undefined)
          }
        />
        {tier === "full" ? (
          <>
            {/* The outlet captions draw only on the full card: at the card's
              12px they would draw at 6px when the whole workflow is fitted,
              and the outline names both outlets in words. */}
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
          </>
        ) : null}
        <NodeContent
          description={
            displayDescription ? (
              <NodeDescription>{displayDescription}</NodeDescription>
            ) : null
          }
          glyph={
            <Play
              aria-hidden="true"
              className={cn(LEAD_GLYPH_CLASS, "text-node-lifecycle")}
              strokeWidth={2}
            />
          }
          // The collector walks every node, not only actions: a broken
          // template token in the Lifecycle config is an issue the toolbar
          // counts, and the badge is how this card admits to it.
          marks={<NodeIssueBadge issues={data.issues} placement="inline" />}
          tier={tier}
          title={displayTitle}
          value={undefined}
        />
      </Node>
    );
  }
);

LifecycleNode.displayName = "LifecycleNode";
