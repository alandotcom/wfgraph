/**
 * Comparison sessions are scoped by workflow and never touch the editable draft.
 * The publication panel installs a server payload; the canvas owns only deleted
 * node positions inside that session.
 */

import type { NodeChange } from "@xyflow/react";
import { compact } from "es-toolkit/array";
import { atom, type Getter } from "jotai";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import {
  buildComparisonDisplayGraph,
  type ComparisonDisplayGraph,
  type ComparisonPositionOverrides,
} from "#src/lib/workflow-comparison";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import { activeWorkspaceAddressAtom } from "#src/lib/workflow-workspace-navigation";

export type ComparisonSubview = "review" | "history";

export type WorkflowComparisonSession = {
  payload: WorkflowComparisonPayload;
  selectedHistoryVersionId: string | null;
  subview: ComparisonSubview;
  positionOverrides: ComparisonPositionOverrides;
};

type ComparisonSessions = Readonly<Record<string, WorkflowComparisonSession>>;
type ComparisonRequestState = {
  epoch: number;
  status: "idle" | "pending" | "error";
  /** The base version the latest request named, null for the current publication. */
  baseVersionId: string | null;
  /** The base version the latest request named when the server had none. */
  missingBaseVersionId?: string | undefined;
};

const comparisonSessionsStateAtom = atom<ComparisonSessions>({});
const comparisonRequestStateAtom = atom<
  Readonly<Record<string, ComparisonRequestState>>
>({});

function requestStateFor(
  states: Readonly<Record<string, ComparisonRequestState>>,
  workflowId: string
): ComparisonRequestState {
  return (
    states[workflowId] ?? { epoch: 0, status: "idle", baseVersionId: null }
  );
}

/**
 * Whether `session` is the comparison an address naming `baseVersionId` shows.
 * A null `baseVersionId` names no base, so any installed comparison is the one
 * it shows.
 */
export function comparisonShowsBase(
  session: WorkflowComparisonSession,
  baseVersionId: string | null
): boolean {
  return (
    baseVersionId === null || session.payload.baseVersion?.id === baseVersionId
  );
}

/**
 * The base version id the active address names: the `compare` of a Changes
 * route. Null when the address is not Changes or names no base, since such an
 * address accepts any comparison.
 */
export const routeComparisonBaseIdAtom = atom((get): string | null => {
  const { key } = get(activeWorkspaceAddressAtom);
  return key.workspace === "changes" ? key.baseVersionId : null;
});

/**
 * Whether the active address is a Changes route of `workflowId` naming a base
 * other than `baseVersionId`.
 */
function routeNamesOtherBase(
  get: Getter,
  workflowId: string,
  baseVersionId: string | null
): boolean {
  const routeBaseId = get(routeComparisonBaseIdAtom);
  return (
    get(activeWorkspaceAddressAtom).workflowId === workflowId &&
    routeBaseId !== null &&
    routeBaseId !== baseVersionId
  );
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
  return get(workflowWorkspaceViewAtom) === "changes" && session
    ? session.payload
    : null;
});

export const isComparisonActiveAtom = atom(
  (get) => get(activeComparisonAtom) !== null
);

/** A request locks the draft before its response is allowed to replace the canvas. */
export const isComparisonPendingAtom = atom((get) => {
  const workflowId = get(currentWorkflowIdAtom);
  return workflowId
    ? requestStateFor(get(comparisonRequestStateAtom), workflowId).status ===
        "pending"
    : false;
});

/** Whether the current workflow's latest comparison request failed. */
export const isComparisonErrorAtom = atom((get) => {
  const workflowId = get(currentWorkflowIdAtom);
  return workflowId
    ? requestStateFor(get(comparisonRequestStateAtom), workflowId).status ===
        "error"
    : false;
});

/**
 * The base version id the current workflow's latest comparison request named,
 * or null when it named the current publication or no request was made.
 */
export const comparisonRequestBaseIdAtom = atom((get) => {
  const workflowId = get(currentWorkflowIdAtom);
  return workflowId
    ? requestStateFor(get(comparisonRequestStateAtom), workflowId).baseVersionId
    : null;
});

/**
 * The base version id the current workflow's latest comparison request named
 * when that version does not exist, or null.
 */
export const missingComparisonBaseIdAtom = atom((get) => {
  const workflowId = get(currentWorkflowIdAtom);
  return workflowId
    ? (requestStateFor(get(comparisonRequestStateAtom), workflowId)
        .missingBaseVersionId ?? null)
    : null;
});

/**
 * Start a request in this editor lifetime and return its workflow-local epoch.
 * `baseVersionId` is the base the request names, null for the current
 * publication.
 */
export const beginWorkflowComparisonRequestAtom = atom(
  null,
  (get, set, workflowId: string, baseVersionId: string | null = null) => {
    const next =
      requestStateFor(get(comparisonRequestStateAtom), workflowId).epoch + 1;
    set(comparisonRequestStateAtom, (states) => ({
      ...states,
      [workflowId]: { epoch: next, status: "pending", baseVersionId },
    }));
    return next;
  }
);

/**
 * A response can unlock only the request that is still current for its
 * workflow. A failure for a base other than the one the active Changes route
 * names settles as idle, so it is never reported against that route.
 */
export const settleWorkflowComparisonRequestAtom = atom(
  null,
  (
    get,
    set,
    input: {
      workflowId: string;
      epoch: number;
      outcome?: "success" | "error";
      /** The base version id the request named, when that version does not exist. */
      missingBaseVersionId?: string | undefined;
    }
  ) => {
    const state = requestStateFor(
      get(comparisonRequestStateAtom),
      input.workflowId
    );
    if (state.epoch !== input.epoch) {
      return false;
    }
    const superseded =
      state.baseVersionId !== null &&
      routeNamesOtherBase(get, input.workflowId, state.baseVersionId);
    set(comparisonRequestStateAtom, (states) => ({
      ...states,
      [input.workflowId]: {
        epoch: state.epoch,
        status: input.outcome === "error" && !superseded ? "error" : "idle",
        baseVersionId: state.baseVersionId,
        missingBaseVersionId: superseded
          ? undefined
          : input.missingBaseVersionId,
      },
    }));
    return true;
  }
);

/**
 * Read-only display graph that remains separate from the draft graph cells.
 * Null unless the installed comparison is the one the Changes route names.
 */
export const comparisonDisplayGraphAtom = atom<ComparisonDisplayGraph | null>(
  (get) => {
    const session = get(comparisonSessionAtom);
    return get(workflowWorkspaceViewAtom) === "changes" &&
      session &&
      comparisonShowsBase(session, get(routeComparisonBaseIdAtom))
      ? buildComparisonDisplayGraph(session.payload, session.positionOverrides)
      : null;
  }
);

/**
 * Install a comparison response. It is refused when a newer request has
 * started, and when the active Changes route names a different base than the
 * response compares against, so a late answer never replaces what that route
 * shows.
 */
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
      selectedHistoryVersionId?: string | null | undefined;
    }
  ) => {
    if (
      requestStateFor(get(comparisonRequestStateAtom), input.workflowId)
        .epoch !== input.epoch ||
      routeNamesOtherBase(
        get,
        input.workflowId,
        input.payload.baseVersion?.id ?? null
      )
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
        },
      };
    });
    return true;
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
      [workflowId]: {
        epoch: state.epoch + 1,
        status: "idle",
        baseVersionId: null,
      },
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
      const deletedNodeIds = new Set(
        session.payload.nodeChanges
          .filter((change) => change.kind === "removed")
          .map((change) => change.nodeId)
      );
      // A position change with no position is React Flow reporting a drag that
      // moved nothing. A change for a node the publication kept belongs to the
      // draft's layout, which this session does not own.
      const moves = compact(
        input.changes.map((change) =>
          change.type === "position" &&
          change.position &&
          deletedNodeIds.has(change.id)
            ? ([change.id, change.position] as const)
            : undefined
        )
      );
      if (moves.length === 0) {
        return sessions;
      }

      return {
        ...sessions,
        [input.workflowId]: {
          ...session,
          positionOverrides: {
            ...session.positionOverrides,
            ...Object.fromEntries(moves),
          },
        },
      };
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
