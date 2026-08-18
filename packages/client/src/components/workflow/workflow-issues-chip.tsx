/**
 * How many things are wrong with the graph, and the way into the list of them.
 *
 * Absent when the graph is clean: absence is the success state, so there is no
 * green tick to read past. Amber only when something is blocking, because a
 * broken template reference still runs.
 */

import { useAtomValue } from "jotai";
import { AlertTriangle } from "lucide-react";
import {
  hasBlockingWorkflowIssuesAtom,
  workflowIssuesAtom,
} from "#src/lib/workflow-issues-store";
import { isWorkflowOwnerAtom } from "#src/lib/workflow-save-store";
import { cn } from "@wfgraph/shared/utils";

export function WorkflowIssuesChip({ onOpen }: { onOpen: () => void }) {
  const issues = useAtomValue(workflowIssuesAtom);
  const hasBlocking = useAtomValue(hasBlockingWorkflowIssuesAtom);
  // Owner-only, checked here rather than by the caller: the list this opens
  // offers Fix and Add, which a viewer cannot do anything with.
  const isOwner = useAtomValue(isWorkflowOwnerAtom);

  const label = `${issues.length} ${issues.length === 1 ? "issue" : "issues"}`;

  if (!isOwner) {
    return null;
  }

  return (
    // The live region is always mounted, so a count appearing from nothing is
    // announced. Rendering the button conditionally inside it would mean the
    // region itself arrives with the text and some readers say nothing.
    <output aria-live="polite" className="shrink-0">
      {issues.length > 0 && (
        // Shaped like the publication badge beside it rather than like the
        // action buttons: this reports state, and pressing it only opens the
        // list of what it is reporting.
        <button
          className={cn(
            "flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-1 font-medium text-xs transition-colors",
            hasBlocking
              ? "border-warning/40 bg-warning/10 text-warning hover:bg-warning/20"
              : "bg-card text-muted-foreground hover:bg-accent"
          )}
          onClick={onOpen}
          title="Show what is wrong with this workflow"
          type="button"
        >
          <AlertTriangle className="size-3.5 shrink-0" />
          {/* Lining figures, so a count crossing into two digits changes the
              width by a predictable step rather than a ragged one. */}
          <span className="tabular-nums">{label}</span>
        </button>
      )}
    </output>
  );
}
