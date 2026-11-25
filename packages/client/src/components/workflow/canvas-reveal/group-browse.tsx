import { useAtomValue } from "jotai";
import { sortBy } from "es-toolkit/array";
import { useMemo } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { NodeDetailsFields } from "#src/components/workflow/node-properties-form";
import { NodeControls } from "#src/components/workflow/step-controls";
import { useFocusWorkflowNode } from "#src/components/workflow/use-focus-workflow-node";
import { can } from "#src/lib/authorization";
import { edgesAtom, nodesAtom } from "#src/lib/workflow-graph-store";
import { groupMemberCountAtom } from "#src/lib/workflow-graph-presentation-store";
import {
  comparisonNodeTitle,
  type WorkflowEdge,
  type WorkflowNode,
} from "#src/lib/workflow-graph-types";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { isGeneratingAtom } from "#src/lib/workflow-ui-store";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
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
              className="grid min-h-9 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 rounded-sm px-2 py-1.5 text-left transition-colors duration-100 hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
 * What a collapsed Group holds and how it connects: `description` when given,
 * its step count, each step, the outside ports that enter it, the member outlet
 * it continues from, the outside ports it continues to, and its Group issues.
 */
function GroupSummarySections({
  groupId,
  description,
  focusField,
}: {
  groupId: string;
  description: string | undefined;
  focusField: RevealBodyProps["focusField"];
}) {
  const catalog = useExtensionCatalog();
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const issues = useAtomValue(workflowIssuesAtom);
  const memberCount = useAtomValue(
    useMemo(() => groupMemberCountAtom(groupId), [groupId])
  );

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
    <>
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
          <NodeIssueList issues={ownIssues} onSelect={() => focusField()} />
        ) : null}
        {memberIssueCount > 0 ? (
          <p className="text-muted-foreground text-xs">
            {memberIssueCount === 1
              ? "1 issue is on a step in this Group. Choose the step to see it."
              : `${memberIssueCount} issues are on steps in this Group. Choose a step to see them.`}
          </p>
        ) : null}
      </Section>
    </>
  );
}

/**
 * The inspector of a collapsed Group: its label and description, editable in
 * place, then its summary, Enter group, which opens the focused Group canvas,
 * and Ungroup and Delete Group and steps. Nothing expands in place.
 */
export function GroupEditor({ subject, frame, focusField }: RevealBodyProps) {
  const nodes = useAtomValue(nodesAtom);
  const isGenerating = useAtomValue(isGeneratingAtom);
  const groupId = subject.nodeId;
  const node = nodes.find((item) => item.id === groupId);
  if (groupId === null || !node) {
    return null;
  }
  return (
    <div className="pb-4">
      <Section title="Details">
        <NodeDetailsFields
          disabled={isGenerating || !can(WfGraphOperations.workflowUpdate.id)}
          node={node}
        />
      </Section>
      <GroupSummarySections
        description={undefined}
        focusField={focusField}
        groupId={groupId}
      />
      <EnterGroupButton groupId={groupId} />
      <NodeControls className="border-t px-4 pt-3" frame={frame} node={node} />
    </div>
  );
}

/**
 * The summary sheet of a collapsed Group on a phone: its description, its
 * summary, and Enter group. The full-screen editor holds the label,
 * description, Ungroup, and Delete Group and steps.
 */
export function GroupSummarySheet({ subject, focusField }: RevealBodyProps) {
  const nodes = useAtomValue(nodesAtom);
  const groupId = subject.nodeId;
  if (groupId === null) {
    return null;
  }
  return (
    <div className="pb-4">
      <GroupSummarySections
        description={
          nodes.find((node) => node.id === groupId)?.data.description
        }
        focusField={focusField}
        groupId={groupId}
      />
      <EnterGroupButton groupId={groupId} />
    </div>
  );
}
