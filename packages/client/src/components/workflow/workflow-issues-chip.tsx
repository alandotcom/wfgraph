/**
 * How many things are wrong with the graph, and the way into the list of them.
 *
 * Absent when the graph is clean: absence is the success state, so there is no
 * green tick to read past. Amber only when something is blocking, because a
 * broken template reference still runs.
 */

import { useAtomValue } from "jotai";
import { AlertTriangle } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import {
  hasBlockingWorkflowIssuesAtom,
  workflowIssuesAtom,
} from "#src/lib/workflow-issues-store";
import { isWorkflowOwnerAtom } from "#src/lib/workflow-save-store";

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
    <output aria-live="polite">
      {issues.length > 0 && (
        // Shaped like the publication badge beside it rather than like the
        // action buttons: this reports state, and pressing it only opens the
        // list of what it is reporting.
        <Button
          icon={
            <Icon
              color={hasBlocking ? "warning" : "secondary"}
              icon={AlertTriangle}
              size="sm"
            />
          }
          label={label}
          onClick={onOpen}
          size="sm"
          tooltip="Show what is wrong with this workflow"
          variant="secondary"
        />
      )}
    </output>
  );
}
