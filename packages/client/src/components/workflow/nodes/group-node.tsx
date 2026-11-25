import { Handle, type NodeProps, Position } from "@xyflow/react";
import { useAtomValue } from "jotai";
import { ArrowRight, Group } from "lucide-react";
import { memo, useMemo } from "react";
import { cn } from "@wfgraph/shared/utils";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import { groupMemberCountAtom } from "#src/lib/workflow-graph-presentation-store";
import {
  COMPARISON_GROUP_ANNOTATION,
  COMPARISON_NODE_ANNOTATION,
  groupLabel,
  type WorkflowNodeData,
} from "#src/lib/workflow-graph-types";
import { NODE_ICON_CLASS } from "#src/lib/workflow-node-dimensions";
import { useStepNumber } from "#src/lib/step-numbers";
import { ComparisonMarker } from "#src/components/flow-elements/comparison-marker";
import {
  NodeCompactBody,
  NodeDescription,
  NodeStepNumber,
  useCompactCard,
} from "#src/components/flow-elements/node";
import { NodeIssueBadge } from "#src/components/flow-elements/node-issue-badge";
import { Button } from "#src/components/ui/button";
import { useGroupScopeNavigation } from "#src/components/workflow/use-group-scope-navigation";
import { useRunGroupSummary } from "#src/components/workflow/use-run-node-evidence";
import {
  groupRunStatusTone,
  statusToneTextClass,
} from "#src/components/workflow/workflow-run-shared";
import {
  groupRunCountsText,
  groupRunStatusLabel,
} from "@wfgraph/shared/graph/group-run-status";

type GroupNodeProps = NodeProps & {
  data?: WorkflowNodeData;
  id: string;
};

/**
 * A Group on the overview: one collapsed card naming the Group and how many
 * steps it holds, or on a run's canvas its run status and member counts. Its
 * members show only on the focused Group canvas, which the card's Enter group
 * button opens. While the review sheet is open the card also counts its
 * changed steps. Zoomed out, the card draws only its number, or the Group
 * glyph when it has none, beside its label; its border still carries the
 * run's outcome.
 */
export const GroupNode = memo(
  ({ data, selected, id, isConnectable }: GroupNodeProps) => {
    const { enterGroup } = useGroupScopeNavigation();
    const memberCount = useAtomValue(
      useMemo(() => groupMemberCountAtom(id), [id])
    );
    // Null outside a run. A Group records nothing in a run, so its status and
    // counts are read from its members' evidence.
    const runSummary = useRunGroupSummary(id);
    const isCompact = useCompactCard();
    const stepNumber = useStepNumber(id);

    if (!data || !isGroupNode({ data })) {
      return null;
    }
    const label = groupLabel(data.label);
    const changedMemberIds =
      data[COMPARISON_GROUP_ANNOTATION]?.changedMemberIds;

    return (
      <div
        className={cn(
          // Graphite Wash behind the Canvas Line border marks the one container
          // on the canvas, and the rule under the title separates its chrome
          // from the summary below.
          "relative flex h-full w-full flex-col rounded-md border-[1.5px] border-canvas-line bg-muted shadow-none",
          // On a run's canvas the border carries an outcome the way a step's
          // does, and only for a status that claims one.
          runSummary?.status === "successful" && "border-2 border-success",
          runSummary?.status === "failed" && "border-2 border-destructive",
          runSummary?.status === "canceled" && "border-2 border-cancelled",
          "group-node-container"
        )}
        data-card-form={isCompact ? "compact" : "full"}
        data-selected={selected}
        data-testid={`group-node-${id}`}
      >
        <ComparisonMarker comparison={data[COMPARISON_NODE_ANNOTATION]} />
        <Handle
          aria-label="Group input"
          isConnectable={isConnectable}
          isConnectableEnd={isConnectable}
          isConnectableStart={isConnectable}
          position={Position.Top}
          role="img"
          type="target"
        />
        {isCompact ? (
          <>
            <NodeIssueBadge issues={data.issues} />
            {/* The run status straddles the top edge where a step card's
              status chip sits, since the compact card has no room for the
              status line and member counts. */}
            {runSummary && runSummary.status !== "idle" ? (
              <div className="pointer-events-none absolute top-0 right-2 left-[calc(50%+10px)] z-10 flex -translate-y-1/2 justify-end-safe">
                <span
                  className={cn(
                    "shrink-0 rounded-sm border bg-card px-1.5 py-0.5 font-medium text-xs leading-none",
                    statusToneTextClass(groupRunStatusTone(runSummary.status))
                  )}
                  data-testid={`group-run-status-${id}`}
                  role="status"
                >
                  {groupRunStatusLabel(runSummary.status)}
                </span>
              </div>
            ) : null}
            <NodeCompactBody
              lead={
                stepNumber === undefined ? (
                  <Group
                    aria-hidden="true"
                    className="size-[0.875em] shrink-0 text-muted-foreground"
                    strokeWidth={2}
                  />
                ) : (
                  <NodeStepNumber className="shrink-0" value={stepNumber} />
                )
              }
              className="flex-1"
              title={label}
            />
          </>
        ) : (
          <>
            <div className="flex h-9 shrink-0 items-center gap-2 border-canvas-line/60 border-b pr-1 pl-3 font-medium text-sm">
              <Group
                className={cn(
                  NODE_ICON_CLASS,
                  "shrink-0 text-muted-foreground"
                )}
                strokeWidth={1.5}
              />
              <span className="min-w-0 flex-1 truncate" title={label}>
                <NodeStepNumber className="mr-1.5" value={stepNumber} />
                {label}
              </span>
              {/* The badge counts the Group rules' issues and each member's, since
              the card hides its members. It shows whatever the members' enabled
              states are, because publication judges every Group. */}
              <NodeIssueBadge issues={data.issues} placement="inline" />
              <Button
                aria-label={`Enter group ${label}`}
                // `nodrag` keeps a press on the button from starting a drag or
                // selecting the card underneath it.
                className="nodrag nopan"
                onClick={(event) => {
                  event.stopPropagation();
                  enterGroup(id);
                }}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <ArrowRight />
              </Button>
            </div>
            {data.description ? (
              <NodeDescription className="shrink-0 px-3 pt-2">
                {data.description}
              </NodeDescription>
            ) : null}
            {runSummary ? (
              <div
                className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-3 text-xs"
                data-testid={`group-run-summary-${id}`}
              >
                <span
                  className={cn(
                    "font-medium",
                    statusToneTextClass(groupRunStatusTone(runSummary.status))
                  )}
                >
                  {groupRunStatusLabel(runSummary.status)}
                </span>
                <span className="truncate text-muted-foreground tabular-nums">
                  {groupRunCountsText(runSummary)}
                </span>
              </div>
            ) : (
              <div className="flex flex-1 items-center gap-2 px-3 text-xs">
                <dl className="flex flex-1 items-center justify-between gap-2">
                  <dt className="text-muted-foreground">Steps</dt>
                  <dd className="font-medium tabular-nums">{memberCount}</dd>
                </dl>
                {/* While the review sheet is open the card counts the changed
                steps inside the Group, which show only once it is entered. */}
                {changedMemberIds ? (
                  <span
                    className="shrink-0 font-medium"
                    data-testid={`group-changed-steps-${id}`}
                  >
                    {changedMemberIds.length} changed
                  </span>
                ) : null}
              </div>
            )}
          </>
        )}
        {/* One outlet for the whole Group. The canvas paints every edge
          leaving the Group from it. Connections keep existing continuation
          ports or use terminal non-Condition members, leaving unused branches
          unwired. */}
        <Handle
          aria-label="Group output"
          isConnectable={isConnectable}
          isConnectableEnd={isConnectable}
          isConnectableStart={isConnectable}
          position={Position.Bottom}
          role="img"
          type="source"
        />
      </div>
    );
  }
);

GroupNode.displayName = "GroupNode";
