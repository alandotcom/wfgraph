import { Handle, type NodeProps, Position } from "@xyflow/react";
import { useAtomValue, useSetAtom } from "jotai";
import { Group, Maximize2, Minimize2 } from "lucide-react";
import { type ComponentProps, memo, useMemo } from "react";
import { cn } from "@wfgraph/shared/utils";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import {
  GROUP_REGION_HEADER_HEIGHT,
  GROUP_REGION_INSET,
} from "@wfgraph/shared/graph/workflow-layout-geometry";
import { groupMemberCountAtom } from "#src/lib/workflow-graph-presentation-store";
import {
  COMPARISON_GROUP_ANNOTATION,
  COMPARISON_NODE_ANNOTATION,
  groupLabel,
  type WorkflowNodeData,
} from "#src/lib/workflow-graph-types";
import { NODE_ICON_CLASS } from "#src/lib/workflow-node-dimensions";
import { useStepNumber } from "#src/lib/step-numbers";
import {
  collapsedGroupIdsAtom,
  toggleGroupCollapsedAtom,
} from "#src/lib/collapsed-groups";
import { ComparisonMarker } from "#src/components/flow-elements/comparison-marker";
import { COMPACT_TITLE_MIN_PX } from "#src/components/flow-elements/compact-card";
import type { CardTier } from "#src/components/workflow/workflow-viewport";
import {
  NodeCompactBody,
  NodeDescription,
  NodeNumberBody,
  NodeStatusMark,
  NodeStepNumber,
  useCardTier,
} from "#src/components/flow-elements/node";
import { NodeIssueBadge } from "#src/components/flow-elements/node-issue-badge";
import { Button } from "#src/components/ui/button";
import { useRunGroupSummary } from "#src/components/workflow/use-run-node-evidence";
import {
  groupRunStatusTone,
  statusToneTextClass,
} from "#src/components/workflow/workflow-run-shared";
import {
  groupRunCountsText,
  groupRunStatusLabel,
  type GroupRunStatus,
  type GroupRunSummary,
} from "@wfgraph/shared/graph/group-run-status";

/**
 * The step status whose mark a Group wears for each Group run status where a
 * word does not fit. A Group that is idle, or reached with no outcome yet,
 * wears none.
 */
const GROUP_STATUS_AS_STEP_STATUS = {
  idle: undefined,
  reached: undefined,
  running: "running",
  waiting: "waiting",
  retrying: "retrying",
  canceled: "cancelled",
  failed: "error",
  successful: "success",
} as const satisfies Record<
  GroupRunStatus,
  ComponentProps<typeof NodeStatusMark>["status"]
>;

/**
 * The size of a region header's glyph and step count at the lowest tier, in
 * canvas pixels: 11px on screen at zoom 0.3, and grown against the zoom below
 * that by `globals.css`.
 */
const GROUP_HEADER_MARK_PX = 36;

type GroupNodeProps = NodeProps & {
  data?: WorkflowNodeData;
  id: string;
};

/** The control on a Group's header that collapses it or draws it in place. */
function CollapseToggle({
  groupId,
  label,
  collapsed,
}: {
  groupId: string;
  label: string;
  collapsed: boolean;
}) {
  const toggle = useSetAtom(toggleGroupCollapsedAtom);
  const action = collapsed ? "Expand" : "Collapse";
  const Icon = collapsed ? Maximize2 : Minimize2;
  return (
    <Button
      aria-label={`${action} group ${label}`}
      // `nodrag` keeps a press on the button from starting a drag or
      // selecting the Group underneath it.
      className="nodrag nopan pointer-events-auto shrink-0"
      onClick={(event) => {
        event.stopPropagation();
        toggle(groupId);
      }}
      size="icon-sm"
      title={`${action} group`}
      type="button"
      variant="ghost"
    >
      <Icon />
    </Button>
  );
}

/** A Group's run status in words, coloured by its tone. */
function GroupRunWords({ summary }: { summary: GroupRunSummary }) {
  return (
    <span
      className={cn(
        "shrink-0 font-medium",
        statusToneTextClass(groupRunStatusTone(summary.status))
      )}
      data-slot="group-run-status"
    >
      {groupRunStatusLabel(summary.status)}
    </span>
  );
}

/**
 * A Group on the canvas. Drawn in place it is a region around its member
 * steps, which are ordinary cards and React Flow children of this node: the
 * node box starts at the frame's position and ends past the last member, and
 * the region's outline and header reach above and left of it. Only the header
 * takes the pointer, so pressing it selects or drags the Group and pressing
 * the region's body reaches the canvas. Collapsed by the viewer it is one card
 * standing for its members, with one inlet and one outlet. Either form carries
 * the Group's issues, its change marker while the review sheet is open, and on
 * a run's canvas the Group's run status.
 */
export const GroupNode = memo((props: GroupNodeProps) => {
  const collapsed = useAtomValue(collapsedGroupIdsAtom).has(props.id);
  return collapsed ? (
    <CollapsedGroupCard {...props} />
  ) : (
    <GroupRegion {...props} />
  );
});

GroupNode.displayName = "GroupNode";

/**
 * A region's header at each card tier. Full, it names the Group in 14px type
 * with its run status and counts, its changed steps and the collapse control.
 * Compact, it names the Group on up to two lines at a compact card's smallest
 * title size, with a status mark. At the lowest tier it shows the Group glyph
 * and how many steps it holds, grown against the zoom like a card's number.
 */
function RegionHeader({
  id,
  data,
  tier,
  runSummary,
}: {
  id: string;
  data: WorkflowNodeData;
  tier: CardTier;
  runSummary: GroupRunSummary | null;
}) {
  const stepNumber = useStepNumber(id);
  const memberCount = useAtomValue(
    useMemo(() => groupMemberCountAtom(id), [id])
  );
  const label = groupLabel(data.label);
  const changedMemberIds = data[COMPARISON_GROUP_ANNOTATION]?.changedMemberIds;
  const markStatus = runSummary
    ? GROUP_STATUS_AS_STEP_STATUS[runSummary.status]
    : undefined;
  const lead =
    stepNumber === undefined ? (
      <Group
        aria-hidden="true"
        className={cn(
          tier === "full" ? NODE_ICON_CLASS : "size-[0.875em]",
          "shrink-0 text-muted-foreground"
        )}
        strokeWidth={1.5}
      />
    ) : (
      <NodeStepNumber className="shrink-0" value={stepNumber} />
    );

  return (
    <div
      className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-t-lg border-canvas-line/60 border-b bg-muted px-3 font-medium"
      data-slot="group-region-header"
      style={{
        height: GROUP_REGION_HEADER_HEIGHT,
        fontSize: tier === "compact" ? COMPACT_TITLE_MIN_PX : undefined,
      }}
      title={label}
    >
      {tier === "number" ? (
        <span
          className="flex items-center gap-2 font-semibold leading-none tabular-nums"
          data-slot="group-region-header-mark"
          style={{ fontSize: GROUP_HEADER_MARK_PX }}
        >
          <Group
            aria-hidden="true"
            className="size-[0.8em] shrink-0 text-muted-foreground"
            strokeWidth={2}
          />
          <span aria-label={`${memberCount} steps`}>{memberCount}</span>
          {markStatus ? (
            <NodeStatusMark
              placement="inline"
              status={markStatus}
              testSkipped={false}
            />
          ) : null}
          <NodeIssueBadge issues={data.issues} placement="inline" />
        </span>
      ) : (
        <>
          {lead}
          <span
            className={cn(
              "min-w-0 flex-1",
              tier === "full"
                ? "truncate text-sm"
                : "line-clamp-2 leading-[1.1] [overflow-wrap:normal]"
            )}
          >
            {label}
          </span>
          <NodeIssueBadge issues={data.issues} placement="inline" />
          {tier === "compact" && markStatus ? (
            <NodeStatusMark
              placement="inline"
              status={markStatus}
              testSkipped={false}
            />
          ) : null}
          {tier === "full" && runSummary && runSummary.status !== "idle" ? (
            <span
              className="flex min-w-0 items-center gap-1.5 text-xs"
              data-testid={`group-run-summary-${id}`}
            >
              <GroupRunWords summary={runSummary} />
              <span className="truncate text-muted-foreground tabular-nums">
                {groupRunCountsText(runSummary)}
              </span>
            </span>
          ) : null}
          {tier === "full" && changedMemberIds ? (
            <span
              className="shrink-0 text-xs"
              data-testid={`group-changed-steps-${id}`}
            >
              {changedMemberIds.length} changed
            </span>
          ) : null}
          {tier === "full" ? (
            <CollapseToggle collapsed={false} groupId={id} label={label} />
          ) : null}
        </>
      )}
    </div>
  );
}

function GroupRegion({ data, selected, id }: GroupNodeProps) {
  // Null outside a run. A Group records nothing in a run, so its status and
  // counts are read from its members' evidence.
  const runSummary = useRunGroupSummary(id);
  const tier = useCardTier();

  if (!data || !isGroupNode({ data })) {
    return null;
  }

  return (
    <div
      className="pointer-events-none relative h-full w-full"
      data-card-form={tier}
      data-group-form="region"
      data-testid={`group-node-${id}`}
    >
      <div
        className={cn(
          // A Wash tint behind a dashed Canvas Line border marks the region
          // as a container without hiding the connections drawn inside it.
          "group-node-container absolute rounded-lg border-[1.5px] border-canvas-line border-dashed bg-muted/40",
          runSummary?.status === "successful" && "border-success border-solid",
          runSummary?.status === "failed" && "border-destructive border-solid",
          runSummary?.status === "canceled" && "border-cancelled border-solid"
        )}
        data-selected={selected}
        style={{
          left: -GROUP_REGION_INSET.left,
          top: -GROUP_REGION_INSET.top,
          right: 0,
          bottom: 0,
        }}
      >
        <ComparisonMarker comparison={data[COMPARISON_NODE_ANNOTATION]} />
        <RegionHeader data={data} id={id} runSummary={runSummary} tier={tier} />
      </div>
    </div>
  );
}

/**
 * A Group the viewer collapsed: one card naming the Group and how many steps
 * it holds, or on a run's canvas its run status and member counts. Every
 * connection into the Group attaches to its one inlet and every connection
 * out of it to its one outlet. While the review sheet is open the card also
 * counts its changed steps. Zoomed out, the card draws only its number, or the
 * Group glyph when it has none, beside its label.
 */
function CollapsedGroupCard({
  data,
  selected,
  id,
  isConnectable,
}: GroupNodeProps) {
  const memberCount = useAtomValue(
    useMemo(() => groupMemberCountAtom(id), [id])
  );
  const runSummary = useRunGroupSummary(id);
  const tier = useCardTier();
  const isCompact = tier !== "full";
  const stepNumber = useStepNumber(id);

  if (!data || !isGroupNode({ data })) {
    return null;
  }
  const label = groupLabel(data.label);
  const changedMemberIds = data[COMPARISON_GROUP_ANNOTATION]?.changedMemberIds;

  return (
    <div
      className={cn(
        // Graphite Wash behind the Canvas Line border marks the one container
        // on the canvas, and the rule under the title separates its chrome
        // from the summary below.
        "pointer-events-auto relative flex h-full w-full flex-col rounded-md border-[1.5px] border-canvas-line bg-muted shadow-none",
        runSummary?.status === "successful" && "border-2 border-success",
        runSummary?.status === "failed" && "border-2 border-destructive",
        runSummary?.status === "canceled" && "border-2 border-cancelled",
        "group-node-container"
      )}
      data-card-form={tier}
      data-group-form="card"
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
          <NodeStatusMark
            status={
              runSummary
                ? GROUP_STATUS_AS_STEP_STATUS[runSummary.status]
                : undefined
            }
            testSkipped={false}
          />
          {tier === "number" ? (
            <NodeNumberBody
              glyph={
                <Group
                  aria-hidden="true"
                  className="size-[0.7em] shrink-0 text-muted-foreground"
                  strokeWidth={2}
                />
              }
              marks={<NodeIssueBadge issues={data.issues} placement="inline" />}
              value={stepNumber}
            />
          ) : (
            <NodeCompactBody
              className="flex-1"
              lead={
                stepNumber === undefined ? (
                  <Group
                    aria-hidden="true"
                    className="size-[0.875em] shrink-0 text-muted-foreground"
                    strokeWidth={2}
                  />
                ) : (
                  <NodeStepNumber value={stepNumber} />
                )
              }
              marks={<NodeIssueBadge issues={data.issues} placement="inline" />}
              title={label}
            />
          )}
        </>
      ) : (
        <>
          <div className="flex h-9 shrink-0 items-center gap-2 border-canvas-line/60 border-b pr-1 pl-3 font-medium text-sm">
            <Group
              className={cn(NODE_ICON_CLASS, "shrink-0 text-muted-foreground")}
              strokeWidth={1.5}
            />
            <span className="min-w-0 flex-1 truncate" title={label}>
              <NodeStepNumber className="mr-1.5" value={stepNumber} />
              {label}
            </span>
            {/* The badge counts the Group rules' issues and each member's,
              since the card hides its members. */}
            <NodeIssueBadge issues={data.issues} placement="inline" />
            <CollapseToggle collapsed groupId={id} label={label} />
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
              <GroupRunWords summary={runSummary} />
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
                steps inside the Group, which its card hides. */}
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
      {/* One outlet for the whole Group. The canvas paints every edge leaving
        the collapsed Group from it. */}
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
