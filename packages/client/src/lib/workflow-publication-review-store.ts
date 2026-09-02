/**
 * Publication preflight owns an immutable draft snapshot until the user closes
 * its review or the publish request finishes. The workflow id scopes that
 * lifetime so a late response cannot attach its graph to a different editor.
 */

import { atom } from "jotai";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import type {
  WorkflowEdgeChange,
  WorkflowNodeChange,
} from "@wfgraph/shared/graph/publication-contracts";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";

export type PublicationReview = {
  baseVersion?: number | undefined;
  proposedVersion: number;
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
  expectedPublishedVersionId: string | null;
  review: PublicationReview;
};

type PublicationReviewSession =
  | PendingPublicationReview
  | ReadyPublicationReview;
type PublicationReviewRequestState = { epoch: number; pending: boolean };

const publicationReviewSessionsStateAtom = atom<
  Readonly<Record<string, PublicationReviewSession>>
>({});
const publicationReviewRequestStateAtom = atom<
  Readonly<Record<string, PublicationReviewRequestState>>
>({});

function requestStateFor(
  states: Readonly<Record<string, PublicationReviewRequestState>>,
  workflowId: string
): PublicationReviewRequestState {
  return states[workflowId] ?? { epoch: 0, pending: false };
}

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

export const isPublicationReviewPendingAtom = atom((get) => {
  const workflowId = get(currentWorkflowIdAtom);
  return workflowId
    ? requestStateFor(get(publicationReviewRequestStateAtom), workflowId)
        .pending
    : false;
});

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
    if (get(currentWorkflowIdAtom) !== workflowId) {
      return null;
    }
    const epoch =
      requestStateFor(get(publicationReviewRequestStateAtom), workflowId)
        .epoch + 1;
    set(publicationReviewRequestStateAtom, (states) => ({
      ...states,
      [workflowId]: { epoch, pending: true },
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
    if (
      requestStateFor(get(publicationReviewRequestStateAtom), review.workflowId)
        .epoch !== review.epoch
    ) {
      return false;
    }
    set(publicationReviewSessionsStateAtom, (sessions) => ({
      ...sessions,
      [review.workflowId]: review,
    }));
    set(publicationReviewRequestStateAtom, (states) => ({
      ...states,
      [review.workflowId]: {
        ...requestStateFor(states, review.workflowId),
        pending: false,
      },
    }));
    return true;
  }
);

/** Marks a current request settled without allowing an older callback to unlock it. */
export const settlePublicationReviewAtom = atom(
  null,
  (get, set, input: { workflowId: string; epoch: number }) => {
    const state = requestStateFor(
      get(publicationReviewRequestStateAtom),
      input.workflowId
    );
    if (state.epoch !== input.epoch) {
      return false;
    }
    set(publicationReviewRequestStateAtom, (states) => ({
      ...states,
      [input.workflowId]: { ...state, pending: false },
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
    const requestStates = get(publicationReviewRequestStateAtom);
    const workflowIds = workflowId ? [workflowId] : Object.keys(requestStates);

    if (
      expectedEpoch !== undefined &&
      requestStateFor(requestStates, workflowId ?? "").epoch !== expectedEpoch
    ) {
      return false;
    }

    set(publicationReviewSessionsStateAtom, (sessions) => {
      if (!workflowId) return {};
      const { [workflowId]: _cleared, ...remaining } = sessions;
      return remaining;
    });
    set(publicationReviewRequestStateAtom, (states) => {
      const next = { ...states };
      for (const id of workflowIds) {
        const state = requestStateFor(states, id);
        next[id] = { epoch: state.epoch + 1, pending: false };
      }
      return next;
    });
    return true;
  }
);
