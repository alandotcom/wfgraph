/**
 * The pieces every Canvas Reveal body is built from: a titled section and the
 * validation issue list of one node.
 */

import type { ReactNode } from "react";
import type { WorkflowIssue } from "@wfgraph/shared/graph/workflow-issues";

/**
 * A Reveal body section: a heading over its content, divided from the next.
 * `headingId` gives the heading an element id that `openFocus` can focus.
 */
export function Section({
  title,
  headingId,
  children,
}: {
  title: string;
  headingId?: string | undefined;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2 border-t px-4 py-3 first:border-t-0">
      <h3
        className="font-medium text-sm"
        id={headingId}
        tabIndex={headingId === undefined ? undefined : -1}
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * The validation issues of one node, each a button that calls `onSelect` with
 * the config key of the field it names, or with nothing.
 */
export function NodeIssueList({
  issues,
  onSelect,
}: {
  issues: readonly WorkflowIssue[];
  onSelect: (fieldKey?: string) => void;
}) {
  if (issues.length === 0) {
    return <p className="text-muted-foreground text-xs">No issues.</p>;
  }
  return (
    <ul className="space-y-1">
      {issues.map((issue) => (
        <li
          key={`${issue.kind}:${"fieldKey" in issue ? issue.fieldKey : ""}:${issue.message}`}
        >
          <button
            className={
              issue.severity === "blocking"
                ? "text-left text-destructive text-xs underline-offset-2 hover:underline"
                : "text-left text-warning text-xs underline-offset-2 hover:underline"
            }
            onClick={() =>
              onSelect("fieldKey" in issue ? issue.fieldKey : undefined)
            }
            type="button"
          >
            {issue.message}
          </button>
        </li>
      ))}
    </ul>
  );
}
