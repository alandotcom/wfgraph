import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { sortBy } from "es-toolkit/array";
import { ArrowDown, ArrowRight } from "lucide-react";
import { useMemo } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { Button } from "#src/components/ui/button";
import { ButtonGroup } from "#src/components/ui/button-group";
import { can } from "#src/lib/authorization";
import {
  edgesAtom,
  nodesAtom,
  setGroupDirectionAtom,
} from "#src/lib/workflow-graph-store";
import { groupMemberCountAtom } from "#src/lib/workflow-graph-presentation-store";
import {
  comparisonNodeTitle,
  type WorkflowEdge,
  type WorkflowNode,
} from "#src/lib/workflow-graph-types";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import {
  scopeOfNode,
  workspaceAddressId,
  workspaceRouteSearch,
} from "#src/lib/workflow-navigation-state";
import {
  activeWorkspaceAddressAtom,
  setWorkspaceSelectionAtom,
} from "#src/lib/workflow-workspace-navigation";
import { useConfigurationSheet } from "#src/hooks/use-configuration-sheet";
import { useIsMobile } from "#src/hooks/use-mobile";
import { isGeneratingAtom } from "#src/lib/workflow-ui-store";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { cn } from "@wfgraph/shared/utils";
import { getConditionBranchDisplayLabel } from "@wfgraph/shared/conditions/condition-branch";
import {
  analyzeGroupBoundaryById,
  type GroupPort,
} from "@wfgraph/shared/graph/group-boundary";
import {
  groupCanvasPositions,
  groupLayoutDirection,
} from "@wfgraph/shared/graph/node-group";
import type { GroupLayoutDirection } from "@wfgraph/shared/graph/schemas";
import type { RevealBodyProps } from "./reveal-kinds";
import { requestRevealPlacementAtom } from "./reveal-requests";
import { EnterGroupButton, NodeIssueList, Section } from "./reveal-sections";

/**
 * Steps named by port, one row each. A port leaving by a Condition branch names
 * the branch after the step.
 */
function StepList({
  ports,
  titleOf,
  empty,
  label,
}: {
  ports: readonly GroupPort[];
  titleOf: (nodeId: string) => string;
  empty: string;
  label: string;
}) {
  return ports.length === 0 ? (
    <p className="text-muted-foreground text-xs">{empty}</p>
  ) : (
    <ul aria-label={label} className="space-y-1">
      {ports.map((port) => {
        const branch = getConditionBranchDisplayLabel(port.handle);
        return (
          <li
            className="truncate text-xs"
            key={`${port.nodeId}\0${port.handle ?? ""}`}
          >
            {titleOf(port.nodeId)}
            {branch ? ` (${branch})` : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The two layout directions a Group offers, in the order the control lists them. */
const DIRECTION_CHOICES: ReadonlyArray<{
  direction: GroupLayoutDirection;
  label: string;
  Icon: typeof ArrowDown;
}> = [
  { direction: "vertical", label: "Top to bottom", Icon: ArrowDown },
  { direction: "horizontal", label: "Left to right", Icon: ArrowRight },
];

/**
 * The Group's stored layout direction as a two-button choice. Choosing the other
 * direction is one undo step that saves, and the focused Group canvas lays its
 * steps out along it.
 */
function DirectionChoice({ groupId }: { groupId: string }) {
  const nodes = useAtomValue(nodesAtom);
  const isGenerating = useAtomValue(isGeneratingAtom);
  const setDirection = useSetAtom(setGroupDirectionAtom);
  const current = groupLayoutDirection(
    nodes.find((node) => node.id === groupId)
  );
  const disabled = isGenerating || !can(WfGraphOperations.workflowUpdate.id);
  return (
    <ButtonGroup aria-label="Layout direction">
      {DIRECTION_CHOICES.map(({ direction, label, Icon }) => (
        <Button
          aria-pressed={current === direction}
          disabled={disabled}
          key={direction}
          onClick={() => setDirection({ groupId, direction })}
          size="sm"
          type="button"
          variant={current === direction ? "secondary" : "outline"}
        >
          <Icon data-icon="inline-start" />
          {label}
        </Button>
      ))}
    </ButtonGroup>
  );
}

/**
 * The members of the Group `groupId` in the row order the focused Group canvas
 * lays them out in.
 */
function orderedMemberIds(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  groupId: string;
}): string[] {
  const boundary = analyzeGroupBoundaryById(input);
  // Row by row, which is the same order in either layout direction, so the
  // vertical positions are enough to sort by.
  const positions = groupCanvasPositions(boundary);
  const members = boundary.memberIds.map((nodeId) => ({
    nodeId,
    position: positions.get(nodeId) ?? { x: 0, y: 0 },
  }));
  return sortBy(members, [
    (member) => member.position.y,
    (member) => member.position.x,
  ]).map((member) => member.nodeId);
}

/**
 * Opens a Group member from the overview: selects it on its Group's focused
 * canvas, asks the camera to place it, and pushes that Group's route, so the
 * member's own inspector opens. `useFocusWorkflowNode` also reaches the Reveal
 * state through the step inspection hook, which imports this module back.
 */
function useOpenGroupMember(): (nodeId: string) => void {
  const store = useStore();
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  const setWorkspaceSelection = useSetAtom(setWorkspaceSelectionAtom);
  const requestPlacement = useSetAtom(requestRevealPlacementAtom);
  const isMobile = useIsMobile();
  const { openSheet } = useConfigurationSheet();
  return (nodeId) => {
    const active = store.get(activeWorkspaceAddressAtom);
    const target = {
      ...active,
      scope: scopeOfNode(store.get(nodesAtom), nodeId),
    };
    setWorkspaceSelection({
      address: target,
      selection: { nodeIds: [nodeId], edgeIds: [] },
    });
    requestPlacement({
      addressId: workspaceAddressId(target),
      nodeIds: [nodeId],
    });
    void navigate({ search: workspaceRouteSearch(target) });
    if (isMobile) {
      openSheet();
    }
  };
}

/**
 * Each step of the Group `groupId` as a button, with its issue count when it
 * has issues. Choosing a step enters the Group and selects that step, which
 * opens its own inspector.
 */
function GroupStepLinks({ groupId }: { groupId: string }) {
  const catalog = useExtensionCatalog();
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const issues = useAtomValue(workflowIssuesAtom);
  const openMember = useOpenGroupMember();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const memberIds = orderedMemberIds({ nodes, edges, groupId });
  if (memberIds.length === 0) {
    return <p className="text-muted-foreground text-xs">No steps.</p>;
  }
  return (
    <ul aria-label="Steps in this Group" className="-mx-2">
      {memberIds.map((nodeId) => {
        const node = byId.get(nodeId);
        const title = node
          ? comparisonNodeTitle(node.data, catalog)
          : "Unknown step";
        const stepIssues = issues.filter((issue) => issue.nodeId === nodeId);
        const count = stepIssues.length;
        const issueText =
          count === 0 ? null : `${count} ${count === 1 ? "issue" : "issues"}`;
        return (
          <li key={nodeId}>
            <button
              aria-label={issueText ? `${title}, ${issueText}` : title}
              className="grid min-h-9 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 rounded-sm px-2 py-1.5 text-left transition-colors duration-100 hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
              onClick={() => openMember(nodeId)}
              type="button"
            >
              <span className="truncate text-sm">{title}</span>
              {issueText ? (
                <span
                  className={cn(
                    "text-xs",
                    stepIssues.some((issue) => issue.severity === "blocking")
                      ? "text-destructive"
                      : "text-warning"
                  )}
                >
                  {issueText}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * What Group Focus shows between the Group's form and its commands: its layout
 * direction, its steps, each opening that step inside the Group, and Enter
 * group.
 */
export function GroupFocusSections({ groupId }: { groupId: string }) {
  return (
    // The form pads its own content, and each section pads itself.
    <div className="-mx-4 border-t">
      <Section title="Layout">
        <DirectionChoice groupId={groupId} />
      </Section>
      <Section title="Steps">
        <GroupStepLinks groupId={groupId} />
      </Section>
      <EnterGroupButton groupId={groupId} />
    </div>
  );
}

/**
 * Browse for a collapsed Group: how many steps it holds, its layout direction,
 * each step, the outside ports that enter it and the ones it continues to, which
 * are the ports the focused canvas draws a stub for, its Group issues, and Enter
 * group, which opens the focused Group canvas. Nothing expands in place.
 */
export function GroupBrowse({ subject, openFocus }: RevealBodyProps) {
  const catalog = useExtensionCatalog();
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const issues = useAtomValue(workflowIssuesAtom);
  const groupId = subject.nodeId;
  const memberCount = useAtomValue(
    useMemo(() => groupMemberCountAtom(groupId ?? ""), [groupId])
  );
  if (groupId === null) {
    return null;
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const titleOf = (nodeId: string) => {
    const node = byId.get(nodeId);
    return node ? comparisonNodeTitle(node.data, catalog) : "Unknown step";
  };
  const boundary = analyzeGroupBoundaryById({ nodes, edges, groupId });
  const ownIssues = issues.filter((issue) => issue.nodeId === groupId);
  const memberIds = new Set(boundary.memberIds);
  const memberIssueCount = issues.filter((issue) =>
    memberIds.has(issue.nodeId)
  ).length;

  return (
    <div className="pb-4">
      <Section title="Group summary">
        <dl className="space-y-1.5 text-xs">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Steps</dt>
            <dd className="tabular-nums">{memberCount}</dd>
          </div>
        </dl>
      </Section>

      <Section title="Layout">
        <DirectionChoice groupId={groupId} />
      </Section>

      <Section title="Steps">
        <GroupStepLinks groupId={groupId} />
      </Section>

      <Section title="Boundary">
        <h4 className="text-muted-foreground text-xs">Incoming from</h4>
        <StepList
          empty="No step enters this Group."
          label="Incoming from"
          ports={boundary.externalIngress}
          titleOf={titleOf}
        />
        <h4 className="pt-1 text-muted-foreground text-xs">Continues to</h4>
        <StepList
          empty="This Group ends the path."
          label="Continues to"
          ports={boundary.externalTargets}
          titleOf={titleOf}
        />
      </Section>

      <Section title="Validation">
        {ownIssues.length > 0 || memberIssueCount === 0 ? (
          <NodeIssueList issues={ownIssues} onSelect={openFocus} />
        ) : null}
        {memberIssueCount > 0 ? (
          <p className="text-muted-foreground text-xs">
            {memberIssueCount === 1
              ? "1 issue is on a step in this Group. Choose the step to see it."
              : `${memberIssueCount} issues are on steps in this Group. Choose a step to see them.`}
          </p>
        ) : null}
      </Section>

      <EnterGroupButton groupId={groupId} />
    </div>
  );
}
