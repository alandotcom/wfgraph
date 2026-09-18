import { ArrowRight } from "lucide-react";
import { cn } from "@wfgraph/shared/utils";
import {
  type GroupRunSummary,
  groupRunCountsText,
  groupRunStatusLabel,
} from "@wfgraph/shared/graph/group-run-status";
import { Button } from "#src/components/ui/button";
import { useGroupScopeNavigation } from "#src/components/workflow/use-group-scope-navigation";
import { useInspectRunNode } from "#src/components/workflow/use-run-node-evidence";
import {
  groupRunStatusTone,
  runNodeEvidenceLabel,
  statusToneTextClass,
} from "#src/components/workflow/workflow-run-shared";
import type { ExecutionLog } from "#src/lib/execution-logs";
import { runNodeTitle } from "#src/lib/run-node-evidence";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { Section } from "./reveal-sections";

/**
 * A Group card's summary in Runs Browse: the Group's run status, its member
 * counts, and each member with its own status. The Group records nothing in a
 * run, so choosing a member enters the Group and opens that member's evidence
 * in Focus.
 */
export function RunsGroupSummary({
  groupId,
  summary,
  nodes,
  logs,
}: {
  groupId: string;
  summary: GroupRunSummary;
  nodes: readonly WorkflowNode[];
  logs: readonly ExecutionLog[];
}) {
  const inspectNode = useInspectRunNode();
  const { enterGroup } = useGroupScopeNavigation();

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4 [scrollbar-gutter:stable]"
      data-testid="runs-group-summary"
    >
      <Section title="Group summary">
        <p
          className={cn(
            "font-medium text-sm",
            statusToneTextClass(groupRunStatusTone(summary.status))
          )}
        >
          {groupRunStatusLabel(summary.status)}
        </p>
        <p className="text-xs tabular-nums">{groupRunCountsText(summary)}</p>
        <p className="text-muted-foreground text-xs">
          A Group records nothing in a run. Choose a step to see its evidence.
        </p>
      </Section>

      <Section title="Steps">
        <ul aria-label="Steps in this Group" className="-mx-2">
          {summary.members.map((member) => {
            const title = runNodeTitle({ nodeId: member.nodeId, nodes, logs });
            const status = runNodeEvidenceLabel(member.status);
            return (
              <li key={member.nodeId}>
                <button
                  aria-label={`${title}, ${status.text}`}
                  className="grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 rounded-sm px-2 py-1.5 text-left transition-colors duration-100 hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                  onClick={() =>
                    inspectNode({
                      nodeId: member.nodeId,
                      logId: null,
                    })
                  }
                  type="button"
                >
                  <span className="truncate font-medium text-sm">{title}</span>
                  <span
                    className={cn("text-xs", statusToneTextClass(status.tone))}
                  >
                    {status.text}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Section>

      <div className="border-t px-4 pt-3">
        <Button
          className="w-full"
          onClick={() => enterGroup(groupId)}
          type="button"
        >
          Enter group
          <ArrowRight data-icon="inline-end" />
        </Button>
      </div>
    </div>
  );
}
