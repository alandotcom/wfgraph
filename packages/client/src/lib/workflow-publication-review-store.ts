/**
 * Publication preflight owns an immutable draft snapshot until the user closes
 * its review or the publish request finishes. The workflow id scopes that
 * lifetime so a late response cannot attach its graph to a different editor.
 */

import { atom } from "jotai";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import type {
  WorkflowComparisonPayload,
  WorkflowEdgeChange,
  WorkflowNodeChange,
} from "@wfgraph/shared/graph/publication-contracts";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";

/**
 * What the Publish confirmation shows. `baseGraph` and `draftGraph` are the
 * comparison's redacted graphs, which the confirmation classifies its changes
 * against.
 */
export type PublicationReview = {
  baseVersion?: number | undefined;
  proposedVersion: number;
  baseGraph: WorkflowComparisonPayload["baseGraph"];
  draftGraph: WorkflowComparisonPayload["draftGraph"];
  nodeChanges: WorkflowNodeChange[];
  edgeChanges: WorkflowEdgeChange[];
};

type PendingPublicationReview = {
  workflowId: string;
  epoch: number;
  pending: true;
};

export type ReadyPublicationReview = {
  workflowId: string;
  epoch: number;
  pending: false;
  graph: SerializedWorkflowGraph;
  expectedDraftRevision: number;
  expectedPublishedVersionId: string | null;
  review: PublicationReview;
};

type PublicationReviewSession =
  | PendingPublicationReview
  | ReadyPublicationReview;

const publicationReviewSessionsStateAtom = atom<
  Readonly<Record<string, PublicationReviewSession>>
>({});
/**
 * The newest epoch issued per workflow. It outlives the session, so a callback
 * from a review that has since been cleared still loses authority.
 */
const publicationReviewEpochsAtom = atom<Readonly<Record<string, number>>>({});

/** The preflight session belongs only to the workflow currently in the editor. */
export const publicationReviewSessionAtom = atom((get) => {
  const workflowId = get(currentWorkflowIdAtom);
  return workflowId
    ? (get(publicationReviewSessionsStateAtom)[workflowId] ?? null)
    : null;
});

/** A preflight locks its workflow while comparison, confirmation, or publish runs. */
export const isPublicationReviewActiveAtom = atom(
  (get) => get(publicationReviewSessionAtom) !== null
);

export const isPublicationReviewPendingAtom = atom(
  (get) => get(publicationReviewSessionAtom)?.pending === true
);

export const publicationReviewAtom = atom<ReadyPublicationReview | null>(
  (get) => {
    const session = get(publicationReviewSessionAtom);
    return session?.pending ? null : (session ?? null);
  }
);

/** Starts a workflow-scoped preflight before its comparison request is sent. */
export const beginPublicationReviewAtom = atom(
  null,
  (get, set, workflowId: string) => {
    if (
      get(currentWorkflowIdAtom) !== workflowId ||
      get(publicationReviewSessionsStateAtom)[workflowId] !== undefined
    ) {
      return null;
    }
    const epoch = (get(publicationReviewEpochsAtom)[workflowId] ?? 0) + 1;
    set(publicationReviewEpochsAtom, (epochs) => ({
      ...epochs,
      [workflowId]: epoch,
    }));
    set(publicationReviewSessionsStateAtom, (sessions) => ({
      ...sessions,
      [workflowId]: { workflowId, epoch, pending: true },
    }));
    return epoch;
  }
);

/**
 * Installs comparison facts only while their workflow remains open. A route
 * change clears the request's session rather than letting stale data reopen it.
 */
export const installPublicationReviewAtom = atom(
  null,
  (get, set, review: ReadyPublicationReview) => {
    if (get(publicationReviewEpochsAtom)[review.workflowId] !== review.epoch) {
      return false;
    }
    set(publicationReviewSessionsStateAtom, (sessions) => ({
      ...sessions,
      [review.workflowId]: review,
    }));
    return true;
  }
);

/** Cancels a review and advances its epoch so a late callback loses authority. */
export const clearPublicationReviewAtom = atom(
  null,
  (get, set, input?: string | { workflowId: string; epoch?: number }) => {
    const workflowId = typeof input === "string" ? input : input?.workflowId;
    const expectedEpoch = typeof input === "string" ? undefined : input?.epoch;
    const epochs = get(publicationReviewEpochsAtom);
    const workflowIds = workflowId ? [workflowId] : Object.keys(epochs);

    if (
      expectedEpoch !== undefined &&
      (epochs[workflowId ?? ""] ?? 0) !== expectedEpoch
    ) {
      return false;
    }

    set(publicationReviewSessionsStateAtom, (sessions) => {
      if (!workflowId) return {};
      const { [workflowId]: _cleared, ...remaining } = sessions;
      return remaining;
    });
    set(publicationReviewEpochsAtom, (current) => {
      const next = { ...current };
      for (const id of workflowIds) {
        next[id] = (current[id] ?? 0) + 1;
      }
      return next;
    });
    return true;
  }
);
