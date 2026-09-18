import {
  Handle,
  type NodeProps,
  Position,
  useUpdateNodeInternals,
} from "@xyflow/react";
import { useAtomValue } from "jotai";
import { ArrowRight, Group } from "lucide-react";
import {
  createContext,
  Fragment,
  memo,
  type ReactNode,
  useContext,
  useMemo,
} from "react";
import { cn } from "@wfgraph/shared/utils";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import { useAfterPaint } from "#src/hooks/effects";
import {
  groupMemberCountAtom,
  groupOutletsAtom,
} from "#src/lib/workflow-graph-presentation-store";
import {
  COMPARISON_GROUP_ANNOTATION,
  COMPARISON_NODE_ANNOTATION,
  groupLabel,
  type WorkflowNodeData,
} from "#src/lib/workflow-graph-types";
import { NODE_ICON_CLASS } from "#src/lib/workflow-node-dimensions";
import { ComparisonMarker } from "#src/components/flow-elements/comparison-marker";
import { NodeIssueBadge } from "#src/components/flow-elements/node-issue-badge";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { Button } from "#src/components/ui/button";
import {
  alongOutletSide,
  OutletLabel,
} from "#src/components/workflow/nodes/outlet-label";
import { groupOutletSlots } from "#src/components/workflow/nodes/group-outlet-slots";
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

/** What a collapsed Group card hands the control for its changed steps. */
export type GroupChangedStepsControlProps = {
  groupLabel: string;
  changedMemberIds: readonly string[];
};

/**
 * The control a canvas supplies for the changed steps inside a Group. A Group
 * card on a comparison canvas draws it beside the step count, and a card under
 * no provider draws none.
 */
export const GroupChangedStepsSlot = createContext<
  ((props: GroupChangedStepsControlProps) => ReactNode) | null
>(null);

type GroupNodeProps = NodeProps & {
  data?: WorkflowNodeData;
  id: string;
};

/**
 * A Group on the overview: one collapsed card naming the Group and how many
 * steps it holds, or on a run's canvas its run status and member counts. Its
 * members show only on the focused Group canvas, which the card's Enter group
 * button opens. On a comparison canvas the card also counts its changed steps
 * and leads to the first one.
 */
export const GroupNode = memo(({ data, selected, id }: GroupNodeProps) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const { enterGroup } = useGroupScopeNavigation();
  const renderChangedSteps = useContext(GroupChangedStepsSlot);
  // The canvas paints each edge leaving a Group as leaving its frame, keeping
  // the member's source handle, and React Flow draws such an edge only from a
  // handle with that id. A Group nothing leaves draws a handle per place a
  // path ends inside it, so a drag starts from the one it continues by.
  const catalog = useExtensionCatalog();
  const outlets = useAtomValue(
    useMemo(() => groupOutletsAtom(id, catalog), [id, catalog])
  );
  const memberCount = useAtomValue(
    useMemo(() => groupMemberCountAtom(id), [id])
  );
  // Null outside a run. A Group records nothing in a run, so its status and
  // counts are read from its members' evidence.
  const runSummary = useRunGroupSummary(id);
  // React Flow records handle ids when it measures a node, so a changed set of
  // ids has to be measured again before an edge can attach to a new one.
  useAfterPaint(outlets, () => {
    updateNodeInternals(id);
  });

  if (!data || !isGroupNode({ data })) {
    return null;
  }
  const label = groupLabel(data.label);
  const slots = groupOutletSlots(outlets.length);
  const changedMemberIds = data[COMPARISON_GROUP_ANNOTATION]?.changedMemberIds;

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
      data-selected={selected}
      data-testid={`group-node-${id}`}
    >
      <ComparisonMarker comparison={data[COMPARISON_NODE_ANNOTATION]} />
      <Handle
        aria-label="Group input"
        position={Position.Top}
        role="img"
        type="target"
      />
      <div className="flex h-9 shrink-0 items-center gap-2 border-canvas-line/60 border-b pr-1 pl-3 font-medium text-sm">
        <Group
          className={cn(NODE_ICON_CLASS, "shrink-0 text-muted-foreground")}
          strokeWidth={1.5}
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
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
          {/* On a comparison canvas the card counts the changed steps inside
              the Group, which show only once the Group is entered. */}
          {changedMemberIds && renderChangedSteps
            ? renderChangedSteps({ changedMemberIds, groupLabel: label })
            : null}
        </div>
      )}
      {outlets.map((outlet, index) => {
        // Several handles spread evenly across the bottom edge, each label
        // within its own handle's slot.
        const { offset, labelMaxWidth } = slots[index];
        return (
          <Fragment key={outlet.handleId ?? ""}>
            <Handle
              aria-label={
                outlet.label === null
                  ? "Group output"
                  : `Group output, ${outlet.label}`
              }
              // React Flow's `id` prop takes a string or `null`, not `undefined`.
              id={outlet.handleId}
              position={Position.Bottom}
              role="img"
              style={alongOutletSide(Position.Bottom, offset)}
              type="source"
            />
            {outlet.label === null ? null : (
              <OutletLabel
                // A member's name can be long, and several labels share the
                // card's bottom edge, so a long name truncates within its
                // slot. The handle's accessible name carries it whole.
                className="truncate"
                maxWidth={labelMaxWidth}
                offset={offset}
                outlet={Position.Bottom}
                title={outlet.label}
              >
                {outlet.label}
              </OutletLabel>
            )}
          </Fragment>
        );
      })}
    </div>
  );
});

GroupNode.displayName = "GroupNode";
