/**
 * The validation issues of the node a config form edits, shown beside the
 * field each one names. The form wraps its fields in `FieldIssuesProvider`, and
 * a field renders `FieldIssueMessages` with its config key. A Lifecycle Rules
 * problem Publish refuses names no config key, so it goes to the rule its
 * check reads, keyed by `lifecycleCheckFieldKey`. A form outside the provider
 * shows no messages.
 */

import { useAtomValue, useSetAtom } from "jotai";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import {
  requiredFieldKey,
  revealedRequiredFieldsAtom,
  revealLeftFieldAtom,
} from "#src/lib/required-field-errors";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import type {
  LifecycleRulesCheckId,
  WorkflowIssue,
} from "@wfgraph/shared/graph/workflow-issues";
import { cn } from "@wfgraph/shared/utils";

/** The config key of the Connection picker, which a missing Connection names. */
const CONNECTION_FIELD_KEY = "integrationId";

const NO_FIELD_ISSUES: ReadonlyMap<string, readonly WorkflowIssue[]> =
  new Map();

const FieldIssuesContext = createContext(NO_FIELD_ISSUES);

/**
 * The key under which the Start's form shows the Lifecycle Rules problems one
 * Publish check reports, beneath the rule that check reads.
 */
export function lifecycleCheckFieldKey(check: LifecycleRulesCheckId): string {
  return `lifecycle-rules:${check}`;
}

/** The config key of the field an issue is about, or null for none. */
export function issueFieldKey(issue: WorkflowIssue): string | null {
  if ("fieldKey" in issue) {
    return issue.fieldKey;
  }
  if (issue.kind === "invalid_lifecycle_rules") {
    return lifecycleCheckFieldKey(issue.check);
  }
  return issue.kind === "missing_integration" ? CONNECTION_FIELD_KEY : null;
}

/**
 * Hands the issues of the node `nodeId` to every field inside it, by key. An
 * empty required field's issue is handed over only once the field has been
 * focused and left, which the provider hears as a blur from the control whose
 * id is the field's config key, or once a Run draft or Publish was refused for
 * it (`required-field-errors.ts`).
 */
export function FieldIssuesProvider({
  nodeId,
  children,
}: {
  nodeId: string;
  children: ReactNode;
}) {
  const issues = useAtomValue(workflowIssuesAtom);
  const revealed = useAtomValue(revealedRequiredFieldsAtom);
  const revealLeftField = useSetAtom(revealLeftFieldAtom);
  const byField = useMemo(
    (): ReadonlyMap<string, readonly WorkflowIssue[]> =>
      Map.groupBy(
        issues.filter(
          (issue) =>
            issue.nodeId === nodeId &&
            issueFieldKey(issue) !== null &&
            (issue.kind !== "missing_required_field" ||
              issue.unreadable === true ||
              revealed.has(requiredFieldKey(nodeId, issue.fieldKey)))
        ),
        (issue) => issueFieldKey(issue) ?? ""
      ),
    [issues, nodeId, revealed]
  );
  return (
    <FieldIssuesContext.Provider value={byField}>
      <div
        className="contents"
        onBlur={(event) => {
          const { id } = event.target;
          if (id !== "") {
            revealLeftField({ nodeId, fieldKey: id });
          }
        }}
      >
        {children}
      </div>
    </FieldIssuesContext.Provider>
  );
}

/**
 * What a field says about one issue. A missing value names the field alone,
 * since the step is already the one on screen.
 */
function fieldIssueText(issue: WorkflowIssue): string {
  if (issue.kind !== "missing_required_field") {
    return issue.message;
  }
  return issue.unreadable
    ? `${issue.fieldLabel} cannot be read.`
    : `${issue.fieldLabel} is required.`;
}

/**
 * The issues that name the field `fieldKey`, one line each in the tone of its
 * severity, or nothing when the field has none.
 */
export function FieldIssueMessages({ fieldKey }: { fieldKey: string }) {
  const issues = useContext(FieldIssuesContext).get(fieldKey);
  if (!issues || issues.length === 0) {
    return null;
  }
  return (
    <ul className="ml-1 space-y-0.5" data-slot="field-issues">
      {issues.map((issue) => (
        <li
          className={cn(
            "text-xs",
            issue.severity === "blocking" ? "text-destructive" : "text-warning"
          )}
          key={`${issue.kind}:${issue.message}`}
        >
          {fieldIssueText(issue)}
        </li>
      ))}
    </ul>
  );
}
