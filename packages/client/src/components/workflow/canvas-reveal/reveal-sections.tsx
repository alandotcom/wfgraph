/**
 * The pieces every Canvas Reveal body is built from: a titled section, the
 * validation issue list of one node, and the Enter group command.
 */

import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "#src/components/ui/button";
import { useGroupScopeNavigation } from "#src/components/workflow/use-group-scope-navigation";
import type { WorkflowIssue } from "@wfgraph/shared/graph/workflow-issues";

/**
 * A Reveal body section: a heading over its content, divided from the next.
 * `headingId` gives the heading an element id that `openFocus` can focus, and
 * `action` is a control shown at the end of the heading row.
 */
export function Section({
  title,
  headingId,
  action,
  children,
}: {
  title: string;
  headingId?: string | undefined;
  action?: ReactNode | undefined;
  children: ReactNode;
}) {
  const heading = (
    <h3
      className="font-medium text-sm"
      id={headingId}
      tabIndex={headingId === undefined ? undefined : -1}
    >
      {title}
    </h3>
  );
  return (
    <section className="space-y-2 border-t px-4 py-3 first:border-t-0">
      {action ? (
        <div className="flex items-center justify-between gap-2">
          {heading}
          {action}
        </div>
      ) : (
        heading
      )}
      {children}
    </section>
  );
}

/**
 * The validation issues of one node. With `onSelect`, each issue is a button
 * that calls it with the config key of the field it names, or undefined, and
 * the issue itself. Without it, each issue is its message alone, for a node
 * with no field to open.
 */
export function NodeIssueList({
  issues,
  onSelect,
}: {
  issues: readonly WorkflowIssue[];
  onSelect?:
    | ((fieldKey: string | undefined, issue: WorkflowIssue) => void)
    | undefined;
}) {
  if (issues.length === 0) {
    return <p className="text-muted-foreground text-xs">No issues.</p>;
  }
  return (
    <ul className="space-y-1">
      {issues.map((issue) => {
        const tone =
          issue.severity === "blocking" ? "text-destructive" : "text-warning";
        return (
          <li
            key={`${issue.kind}:${"fieldKey" in issue ? issue.fieldKey : ""}:${issue.message}`}
          >
            {onSelect ? (
              <button
                className={`text-left ${tone} text-xs underline-offset-2 hover:underline`}
                onClick={() =>
                  onSelect(
                    "fieldKey" in issue ? issue.fieldKey : undefined,
                    issue
                  )
                }
                type="button"
              >
                {issue.message}
              </button>
            ) : (
              <p className={`${tone} text-xs`}>{issue.message}</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Enter group at the end of a Group's summary, which opens the focused canvas
 * of `groupId` in the active workspace.
 */
export function EnterGroupButton({ groupId }: { groupId: string }) {
  const { enterGroup } = useGroupScopeNavigation();
  return (
    <div className="border-t px-4 py-3">
      <Button
        className="w-full"
        onClick={() => enterGroup(groupId)}
        type="button"
      >
        Enter group
        <ArrowRight data-icon="inline-end" />
      </Button>
    </div>
  );
}
