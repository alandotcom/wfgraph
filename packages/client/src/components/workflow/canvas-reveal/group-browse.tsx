import { useAtomValue } from "jotai";
import { sortBy } from "es-toolkit/array";
import { useMemo } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { useFocusWorkflowNode } from "#src/components/workflow/use-focus-workflow-node";
import { edgesAtom, nodesAtom } from "#src/lib/workflow-graph-store";
import { groupMemberCountAtom } from "#src/lib/workflow-graph-presentation-store";
import {
  comparisonNodeTitle,
  type WorkflowEdge,
  type WorkflowNode,
} from "#src/lib/workflow-graph-types";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { cn } from "@wfgraph/shared/utils";
import { getConditionBranchDisplayLabel } from "@wfgraph/shared/conditions/condition-branch";
import {
  analyzeGroupBoundaryById,
  type GroupPort,
} from "@wfgraph/shared/graph/group-boundary";
import type { RevealBodyProps } from "./reveal-kinds";
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

/**
 * The members of the Group `groupId`, ordered by their stored positions.
 */
function orderedMemberIds(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  groupId: string;
}): string[] {
  const members = input.nodes.filter((node) => node.parentId === input.groupId);
  return sortBy(members, [
    (member) => member.position.y,
    (member) => member.position.x,
  ]).map((member) => member.id);
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
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const focusNode = useFocusWorkflowNode();
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
              onClick={() => {
                if (workflowId) {
                  focusNode({ nodeId, workflowId });
                }
              }}
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
 * Group Focus lists its steps, each opening that step inside the Group.
 */
export function GroupFocusSections({ groupId }: { groupId: string }) {
  return (
    // The form pads its own content, and each section pads itself.
    <div className="-mx-4 border-t">
      <Section title="Steps">
        <GroupStepLinks groupId={groupId} />
      </Section>
      <EnterGroupButton groupId={groupId} />
    </div>
  );
}

/**
 * Browse for a collapsed Group: how many steps it holds,
 * each step, the outside ports that enter it, the member outlet it continues
 * from, and the outside ports it continues to, its Group issues, and Enter
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
  const description = byId.get(groupId)?.data.description;
  const boundary = analyzeGroupBoundaryById({ nodes, edges, groupId });
  const ownIssues = issues.filter((issue) => issue.nodeId === groupId);
  const memberIds = new Set(boundary.memberIds);
  const memberIssueCount = issues.filter((issue) =>
    memberIds.has(issue.nodeId)
  ).length;

  return (
    <div className="pb-4">
      <Section title="Group summary">
        {description ? (
          <p className="whitespace-pre-wrap text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {description}
          </p>
        ) : null}
        <dl className="space-y-1.5 text-xs">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Steps</dt>
            <dd className="tabular-nums">{memberCount}</dd>
          </div>
        </dl>
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
        <h4 className="pt-1 text-muted-foreground text-xs">Continues from</h4>
        <StepList
          empty="No step inside this Group continues outside it."
          label="Continues from"
          ports={boundary.internalContinuation}
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
