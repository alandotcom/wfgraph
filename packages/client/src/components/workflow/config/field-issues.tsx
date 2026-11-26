/**
 * The validation issues of the node a config form edits, shown beside the
 * field each one names. The form wraps its fields in `FieldIssuesProvider`, a
 * field renders `FieldIssueMessages` with its config key, and the form places
 * `UnclaimedFieldIssues` where every other issue of the node shows: one that
 * names no field, and one whose field is not on screen, such as a field its
 * `showWhen` hides or a Connection picker a read-only viewer does not get. A
 * Lifecycle Rules problem Publish refuses names no config key, so it goes to
 * the rule its check reads, keyed by `lifecycleCheckFieldKey`. A form outside
 * the provider shows no messages.
 */

import { useAtomValue, useSetAtom } from "jotai";
import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useRegistrationBeforePaint } from "#src/hooks/effects";
import {
  lifecycleCheckFieldKey,
  requiredFieldKey,
  revealedRequiredFieldsAtom,
  revealLeftFieldAtom,
} from "#src/lib/required-field-errors";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import type { WorkflowIssue } from "@wfgraph/shared/graph/workflow-issues";
import { cn } from "@wfgraph/shared/utils";
import { NodeIssueList } from "#src/components/workflow/canvas-reveal/reveal-sections";

/** The config key of the Connection picker, which a missing Connection names. */
const CONNECTION_FIELD_KEY = "integrationId";

/**
 * The field keys the mounted `FieldIssueMessages` of one form claim, counted,
 * since two messages may show the same key. `claimed` is replaced on every
 * change, so `useSyncExternalStore` reads a new snapshot exactly then.
 */
class FieldClaims {
  claimed: ReadonlyMap<string, number> = new Map();
  private readonly listeners = new Set<() => void>();

  claim(fieldKey: string): () => void {
    this.change(fieldKey, 1);
    return () => this.change(fieldKey, -1);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): ReadonlyMap<string, number> => this.claimed;

  private change(fieldKey: string, by: number) {
    const next = new Map(this.claimed);
    const count = (next.get(fieldKey) ?? 0) + by;
    if (count > 0) {
      next.set(fieldKey, count);
    } else {
      next.delete(fieldKey);
    }
    this.claimed = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

type FieldIssues = {
  /** The node's issues a person may see now, in the collector's order. */
  issues: readonly WorkflowIssue[];
  /** The same issues by the field key each names. */
  byField: ReadonlyMap<string, readonly WorkflowIssue[]>;
  /** Whether the node's field `fieldKey` shows the issues that wait. */
  isRevealed: (fieldKey: string) => boolean;
  claims: FieldClaims | null;
};

const NO_FIELD_ISSUES: FieldIssues = {
  issues: [],
  byField: new Map(),
  isRevealed: () => false,
  claims: null,
};

const FieldIssuesContext = createContext(NO_FIELD_ISSUES);

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
 * Hands the issues of the node `nodeId` to every field inside it, by key, and
 * the rest to `UnclaimedFieldIssues`. An empty required field's issue is
 * handed over only once the field has been focused and left, which the
 * provider hears as a blur from the control whose id is the field's config
 * key, or once a Run draft or Publish was refused for it
 * (`required-field-errors.ts`).
 */
export function FieldIssuesProvider({
  nodeId,
  children,
}: {
  nodeId: string;
  children: ReactNode;
}) {
  const allIssues = useAtomValue(workflowIssuesAtom);
  const revealed = useAtomValue(revealedRequiredFieldsAtom);
  const revealLeftField = useSetAtom(revealLeftFieldAtom);
  const [claims] = useState(() => new FieldClaims());
  const value = useMemo((): FieldIssues => {
    const issues = allIssues.filter(
      (issue) =>
        issue.nodeId === nodeId &&
        (issue.kind !== "missing_required_field" ||
          issue.unreadable === true ||
          revealed.has(requiredFieldKey(nodeId, issue.fieldKey)))
    );
    return {
      issues,
      byField: Map.groupBy(
        issues.filter((issue) => issueFieldKey(issue) !== null),
        (issue) => issueFieldKey(issue) ?? ""
      ),
      isRevealed: (fieldKey) =>
        revealed.has(requiredFieldKey(nodeId, fieldKey)),
      claims,
    };
  }, [allIssues, nodeId, revealed, claims]);
  return (
    <FieldIssuesContext.Provider value={value}>
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
 * Whether the field `fieldKey` of the provider's node shows the issues that
 * wait: it has been focused and left, or a Run draft or Publish was refused
 * for it. A rule builder reads it for the field its refusal names.
 */
export function useFieldRevealed(fieldKey: string): boolean {
  return useContext(FieldIssuesContext).isRevealed(fieldKey);
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
 * Whether the field's rule builder already says what the issue says: a
 * Lifecycle Rules refusal of a rule nobody has finished, which the builder
 * names beneath that rule's value.
 */
function namedByItsRule(issue: WorkflowIssue): boolean {
  return issue.kind === "invalid_lifecycle_rules" && issue.unfinished === true;
}

/**
 * The issues that name the field `fieldKey`, one line each in the tone of its
 * severity, or nothing when the field has none. While it is mounted it claims
 * `fieldKey`, so `UnclaimedFieldIssues` leaves those issues to it, including
 * the ones its rule builder names instead.
 */
export function FieldIssueMessages({ fieldKey }: { fieldKey: string }) {
  const { byField, claims } = useContext(FieldIssuesContext);
  useRegistrationBeforePaint(fieldKey, () =>
    claims === null ? () => {} : claims.claim(fieldKey)
  );
  const issues = byField
    .get(fieldKey)
    ?.filter((issue) => !namedByItsRule(issue));
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

const NO_CLAIMS: ReadonlyMap<string, number> = new Map();
const noSubscription = () => () => {};

/**
 * Every issue of the provider's node that no mounted `FieldIssueMessages`
 * shows, or nothing when there is none: an issue that names no field, and one
 * whose field is not on screen. Each form places it once, where such issues
 * belong in its layout.
 */
export function UnclaimedFieldIssues() {
  const { issues, claims } = useContext(FieldIssuesContext);
  const claimed = useSyncExternalStore(
    claims?.subscribe ?? noSubscription,
    claims?.snapshot ?? (() => NO_CLAIMS)
  );
  const unclaimed = issues.filter((issue) => {
    const fieldKey = issueFieldKey(issue);
    return fieldKey === null || !claimed.has(fieldKey);
  });
  return unclaimed.length > 0 ? <NodeIssueList issues={unclaimed} /> : null;
}
