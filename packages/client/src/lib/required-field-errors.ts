/**
 * Which empty required fields say so. A step just added holds empty required
 * fields, and red "is required" text under each before anyone has typed reads
 * as a mistake already made. A field shows that text once it has been focused
 * and left, or once a Run draft or Publish was refused while it stood empty.
 * A rule builder's unfinished rules wait the same way, keyed by the field the
 * refusal names. The issue itself counts from the start: the outline's issue
 * mark and the issue list read `workflowIssuesAtom`, which this module does
 * not touch. Kept per workflow, for the life of the editor session.
 */

import { atom, type Getter, type Setter } from "jotai";
import type {
  LifecycleRulesCheckId,
  WorkflowIssue,
} from "@wfgraph/shared/graph/workflow-issues";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";

const NO_FIELDS: ReadonlySet<string> = new Set();

const revealedByWorkflowAtom = atom<
  Readonly<Record<string, ReadonlySet<string>>>
>({});

/**
 * The key under which the Start's form shows the Lifecycle Rules problems one
 * Publish check reports, beneath the rule that check reads.
 */
export function lifecycleCheckFieldKey(check: LifecycleRulesCheckId): string {
  return `lifecycle-rules:${check}`;
}

/** The key a field of a step goes by in the revealed set. */
export function requiredFieldKey(nodeId: string, fieldKey: string): string {
  return `${nodeId}\u0000${fieldKey}`;
}

/** The fields of the open workflow whose empty-required text shows. */
export const revealedRequiredFieldsAtom = atom((get): ReadonlySet<string> => {
  const workflowId = get(currentWorkflowIdAtom);
  return workflowId === null
    ? NO_FIELDS
    : (get(revealedByWorkflowAtom)[workflowId] ?? NO_FIELDS);
});

function reveal(get: Getter, set: Setter, keys: readonly string[]): void {
  const workflowId = get(currentWorkflowIdAtom);
  const current = get(revealedRequiredFieldsAtom);
  if (workflowId === null || keys.every((key) => current.has(key))) {
    return;
  }
  set(revealedByWorkflowAtom, {
    ...get(revealedByWorkflowAtom),
    [workflowId]: new Set([...current, ...keys]),
  });
}

/** A person focused the field `fieldKey` of the step `nodeId` and left it. */
export const revealLeftFieldAtom = atom(
  null,
  (get, set, input: { nodeId: string; fieldKey: string }) => {
    reveal(get, set, [requiredFieldKey(input.nodeId, input.fieldKey)]);
  }
);

/**
 * The field a refused issue names, when that field waits before it shows an
 * issue: an empty required field, or a Lifecycle Rules check whose rule
 * builder holds rules that wait until they have been left.
 */
function waitingFieldKey(issue: WorkflowIssue): string | null {
  switch (issue.kind) {
    case "missing_required_field":
      return issue.fieldKey;
    case "invalid_lifecycle_rules":
      return lifecycleCheckFieldKey(issue.check);
    default:
      return null;
  }
}

/**
 * A Run draft or Publish was refused for `issues`: every waiting field among
 * them says so from now on.
 */
export const revealRefusedFieldsAtom = atom(
  null,
  (get, set, issues: readonly WorkflowIssue[]) => {
    reveal(
      get,
      set,
      issues.flatMap((issue) => {
        const fieldKey = waitingFieldKey(issue);
        return fieldKey === null
          ? []
          : [requiredFieldKey(issue.nodeId, fieldKey)];
      })
    );
  }
);
