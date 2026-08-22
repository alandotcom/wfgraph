/**
 * How many things are wrong with the graph, and the way into the list of them.
 *
 * Absent when the graph is clean: absence is the success state, so there is no
 * green tick to read past. Amber only when something is blocking, because a
 * broken template reference still runs.
 */

import { useAtomValue } from "jotai";
import { AlertTriangle } from "lucide-react";
import { useShowWorkflowIssues } from "#src/hooks/use-workflow-issues";
import {
  hasBlockingWorkflowIssuesAtom,
  workflowIssuesAtom,
} from "#src/lib/workflow-issues-store";
import { isWorkflowOwnerAtom } from "#src/lib/workflow-save-store";
import { cn } from "@wfgraph/shared/utils";

/** The count as it reads, extracted so the strip's wording needs no DOM to test. */
export function workflowIssuesLabel(count: number): string {
  return `${count} ${count === 1 ? "issue" : "issues"}`;
}

export function WorkflowIssuesChip() {
  const issues = useAtomValue(workflowIssuesAtom);
  const hasBlocking = useAtomValue(hasBlockingWorkflowIssuesAtom);
  // Owner-only, checked here rather than by the caller: the list this opens
  // offers Fix and Add, which a viewer cannot do anything with.
  const isOwner = useAtomValue(isWorkflowOwnerAtom);
  const showIssues = useShowWorkflowIssues();

  if (!isOwner || issues.length === 0) {
    return null;
  }

  return (
    // Not a live region of its own. The strip that mounts this is one polite
    // region covering everything it says, so a count arriving from nothing is
    // announced there; a nested region inside it would queue the same sentence
    // behind itself and read it twice.
    <button
      className={cn(
        "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1.5 py-0.5 font-medium transition-colors",
        hasBlocking
          ? "text-warning hover:bg-warning/10"
          : "hover:bg-accent hover:text-foreground"
      )}
      onClick={showIssues}
      title="Show what is wrong with this workflow"
      type="button"
    >
      <AlertTriangle className="size-3 shrink-0" />
      {/* Lining figures, so a count crossing into two digits changes the
          width by a predictable step rather than a ragged one. */}
      <span className="tabular-nums">{workflowIssuesLabel(issues.length)}</span>
    </button>
  );
}
