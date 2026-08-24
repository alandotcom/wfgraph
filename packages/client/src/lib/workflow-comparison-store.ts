/**
 * Comparison sessions are scoped by workflow and never touch the editable draft.
 * The publication panel installs a server payload; the canvas owns only deleted
 * node positions inside that session.
 */

import type { NodeChange } from "@xyflow/react";
import { atom } from "jotai";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import {
  buildComparisonDisplayGraph,
  type ComparisonDisplayGraph,
  type ComparisonPositionOverrides,
} from "#src/lib/workflow-comparison";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";

export type ComparisonSubview = "review" | "history";

export type WorkflowComparisonSession = {
  payload: WorkflowComparisonPayload;
  selectedHistoryVersionId: string | null;
  subview: ComparisonSubview;
  positionOverrides: ComparisonPositionOverrides;
  visible: boolean;
};

type ComparisonSessions = Readonly<Record<string, WorkflowComparisonSession>>;
type ComparisonRequestState = {
  epoch: number;
  pending: boolean;
};

const comparisonSessionsStateAtom = atom<ComparisonSessions>({});
const comparisonRequestStateAtom = atom<
  Readonly<Record<string, ComparisonRequestState>>
>({});

function requestStateFor(
  states: Readonly<Record<string, ComparisonRequestState>>,
  workflowId: string
): ComparisonRequestState {
  return states[workflowId] ?? { epoch: 0, pending: false };
}

/** The comparison session for the workflow open in the editor, if one exists. */
export const comparisonSessionAtom = atom<WorkflowComparisonSession | null>(
  (get) => {
    const workflowId = get(currentWorkflowIdAtom);
    return workflowId
      ? (get(comparisonSessionsStateAtom)[workflowId] ?? null)
      : null;
  }
);

export const activeComparisonAtom = atom((get) => {
  const session = get(comparisonSessionAtom);
  return session?.visible ? session.payload : null;
});

export const isComparisonActiveAtom = atom(
  (get) => get(activeComparisonAtom) !== null
);

/** A request locks the draft before its response is allowed to replace the canvas. */
export const isComparisonPendingAtom = atom((get) => {
  const workflowId = get(currentWorkflowIdAtom);
  return workflowId
    ? requestStateFor(get(comparisonRequestStateAtom), workflowId).pending
    : false;
});

/** Start a request in this editor lifetime and return its workflow-local epoch. */
export const beginWorkflowComparisonRequestAtom = atom(
  null,
  (get, set, workflowId: string) => {
    const next =
      requestStateFor(get(comparisonRequestStateAtom), workflowId).epoch + 1;
    set(comparisonRequestStateAtom, (states) => ({
      ...states,
      [workflowId]: { epoch: next, pending: true },
    }));
    return next;
  }
);

/** A response can unlock only the request that is still current for its workflow. */
export const settleWorkflowComparisonRequestAtom = atom(
  null,
  (get, set, input: { workflowId: string; epoch: number }) => {
    const state = requestStateFor(
      get(comparisonRequestStateAtom),
      input.workflowId
    );
    if (state.epoch !== input.epoch) {
      return false;
    }
    set(comparisonRequestStateAtom, (states) => ({
      ...states,
      [input.workflowId]: { ...state, pending: false },
    }));
    return true;
  }
);

/** Read-only display graph that remains separate from the draft graph cells. */
export const comparisonDisplayGraphAtom = atom<ComparisonDisplayGraph | null>(
  (get) => {
    const session = get(comparisonSessionAtom);
    return session?.visible
      ? buildComparisonDisplayGraph(session.payload, session.positionOverrides)
      : null;
  }
);

export const installWorkflowComparisonAtom = atom(
  null,
  (
    get,
    set,
    input: {
      workflowId: string;
      epoch: number;
      payload: WorkflowComparisonPayload;
      preserveSession?: boolean;
      selectedHistoryVersionId?: string | null;
    }
  ) => {
    if (
      requestStateFor(get(comparisonRequestStateAtom), input.workflowId)
        .epoch !== input.epoch
    ) {
      return false;
    }
    set(comparisonSessionsStateAtom, (sessions) => {
      const existing = sessions[input.workflowId];
      const preserve = (input.preserveSession ?? Boolean(existing)) && existing;
      return {
        ...sessions,
        [input.workflowId]: {
          payload: input.payload,
          selectedHistoryVersionId:
            input.selectedHistoryVersionId ??
            input.payload.baseVersion?.id ??
            (preserve ? existing.selectedHistoryVersionId : null),
          subview: preserve ? existing.subview : "review",
          positionOverrides: preserve ? existing.positionOverrides : {},
          visible: true,
        },
      };
    });
    return true;
  }
);

export const setWorkflowComparisonVisibleAtom = atom(
  null,
  (_get, set, input: { workflowId: string; visible: boolean }) => {
    set(comparisonSessionsStateAtom, (sessions) => {
      const session = sessions[input.workflowId];
      return session
        ? {
            ...sessions,
            [input.workflowId]: { ...session, visible: input.visible },
          }
        : sessions;
    });
  }
);

export const clearWorkflowComparisonAtom = atom(
  null,
  (get, set, workflowId: string) => {
    set(comparisonSessionsStateAtom, (sessions) => {
      const { [workflowId]: _cleared, ...remaining } = sessions;
      return remaining;
    });
    const state = requestStateFor(get(comparisonRequestStateAtom), workflowId);
    set(comparisonRequestStateAtom, (states) => ({
      ...states,
      [workflowId]: { epoch: state.epoch + 1, pending: false },
    }));
  }
);

export const selectComparisonHistoryVersionAtom = atom(
  null,
  (_get, set, input: { workflowId: string; versionId: string | null }) => {
    set(comparisonSessionsStateAtom, (sessions) => {
      const session = sessions[input.workflowId];
      return session
        ? {
            ...sessions,
            [input.workflowId]: {
              ...session,
              selectedHistoryVersionId: input.versionId,
            },
          }
        : sessions;
    });
  }
);

export const setComparisonSubviewAtom = atom(
  null,
  (_get, set, input: { workflowId: string; subview: ComparisonSubview }) => {
    set(comparisonSessionsStateAtom, (sessions) => {
      const session = sessions[input.workflowId];
      return session
        ? {
            ...sessions,
            [input.workflowId]: { ...session, subview: input.subview },
          }
        : sessions;
    });
  }
);

/**
 * Accepts React Flow position changes for historical nodes only. Position events
 * cover pointer drags and its built-in arrow-key movement through one route.
 */
export const moveComparisonNodesAtom = atom(
  null,
  (
    _get,
    set,
    input: { workflowId: string; changes: NodeChange<WorkflowNode>[] }
  ) => {
    set(comparisonSessionsStateAtom, (sessions) => {
      const session = sessions[input.workflowId];
      if (!session) {
        return sessions;
      }
      const nextPositions = { ...session.positionOverrides };
      const deletedNodeIds = new Set(
        session.payload.nodeChanges
          .filter((change) => change.kind === "removed")
          .map((change) => change.nodeId)
      );
      let changed = false;
      for (const change of input.changes) {
        if (
          change.type === "position" &&
          change.position &&
          deletedNodeIds.has(change.id)
        ) {
          nextPositions[change.id] = change.position;
          changed = true;
        }
      }
      return changed
        ? {
            ...sessions,
            [input.workflowId]: {
              ...session,
              positionOverrides: nextPositions,
            },
          }
        : sessions;
    });
  }
);

export const resetComparisonLayoutAtom = atom(
  null,
  (_get, set, workflowId: string) => {
    set(comparisonSessionsStateAtom, (sessions) => {
      const session = sessions[workflowId];
      return session
        ? {
            ...sessions,
            [workflowId]: { ...session, positionOverrides: {} },
          }
        : sessions;
    });
  }
);
