/**
 * The mark a node wears when the validator has something to say about it.
 *
 * One badge for every kind of issue, the missing connection each action card
 * used to draw for itself included. It shares the top-left corner with the
 * disabled badge and never the top-right one the run-status chip owns.
 */

import { AlertTriangle } from "lucide-react";
import type { NodeIssueSummary } from "#src/lib/workflow-graph-types";
import { cn } from "@wfgraph/shared/utils";

/** "…, 2 issues" for a node's accessible name, or nothing when it is clean. */
export function nodeIssueLabel(issues: NodeIssueSummary | undefined): string {
  if (!issues) {
    return "";
  }
  const count = issues.messages.length;
  const noun = count === 1 ? "issue" : "issues";
  return issues.severity === "blocking"
    ? `${count} blocking ${noun}`
    : `${count} ${noun}`;
}

export function NodeIssueBadge({
  issues,
  placement = "corner",
}: {
  issues: NodeIssueSummary | undefined;
  /**
   * "corner" for a full-size card, where it sits where the connection warning
   * always sat. "inline" for a Group's 56px member row, which has no corner to
   * spare: a badge floated over it would land on the icon.
   */
  placement?: "corner" | "inline";
}) {
  if (!issues) {
    return null;
  }

  const [first, ...rest] = issues.messages;

  return (
    <div
      aria-label={nodeIssueLabel(issues)}
      className={cn(
        "rounded-full p-1",
        placement === "corner" ? "absolute top-2 left-2 z-10" : "shrink-0",
        // Blocking earns the warning colour; a warning-severity issue stays
        // graphite, because a broken template reference still runs.
        issues.severity === "blocking"
          ? "bg-warning/50"
          : "bg-muted-foreground/40"
      )}
      role="img"
      title={rest.length > 0 ? `${first} and ${rest.length} more` : first}
    >
      <AlertTriangle className="size-3.5 text-background" />
    </div>
  );
}
