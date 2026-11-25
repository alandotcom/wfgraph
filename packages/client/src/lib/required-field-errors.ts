/**
 * Which empty required fields say so. A step just added holds empty required
 * fields, and red "is required" text under each before anyone has typed reads
 * as a mistake already made. A field shows that text once it has been focused
 * and left, or once a Run draft or Publish was refused while it stood empty.
 * The issue itself counts from the start: the outline's issue mark and the
 * issue list read `workflowIssuesAtom`, which this module does not touch.
 * Kept per workflow, for the life of the editor session.
 */

import { atom, type Getter, type Setter } from "jotai";
import type { WorkflowIssue } from "@wfgraph/shared/graph/workflow-issues";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";

const NO_FIELDS: ReadonlySet<string> = new Set();

const revealedByWorkflowAtom = atom<
  Readonly<Record<string, ReadonlySet<string>>>
>({});

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
 * A Run draft or Publish was refused for `issues`: every empty required field
 * among them says so from now on.
 */
export const revealRefusedFieldsAtom = atom(
  null,
  (get, set, issues: readonly WorkflowIssue[]) => {
    reveal(
      get,
      set,
      issues.flatMap((issue) =>
        issue.kind === "missing_required_field"
          ? [requiredFieldKey(issue.nodeId, issue.fieldKey)]
          : []
      )
    );
  }
);
