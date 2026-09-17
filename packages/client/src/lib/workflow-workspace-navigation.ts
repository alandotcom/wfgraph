/**
 * The workspace address the editor route names, and the navigation each
 * address remembers. The route is the system of record for the active address;
 * the selection, Canvas Reveal state, and cameras stored here per address are
 * the system of record for those values. The UI and graph stores read this module.
 */

import { atom, type Getter } from "jotai";
import { readCookie, writeCookie } from "#src/lib/preference-cookies";
import {
  EMPTY_WORKFLOW_NAVIGATION,
  inspectionInGraph,
  rememberRouteSearch,
  revealFollowsSelection,
  scopeNavigationAt,
  updateScopeNavigation,
  withCamera,
  withDesktopRevealLevel,
  withInspectedOrigin,
  withInspectorScroll,
  withInspectorSection,
  withChosenExecution,
  withSelection,
  withSelectionOpeningReveal,
  withShowSuperseded,
  withoutDraftSelections,
  withoutGroupCameras,
  workspaceAddressFromSearch,
  type CanvasSelection,
  type DesktopScopePresentation,
  type FormFactor,
  type InspectedOrigin,
  type NavigationGraph,
  type OpenRevealLevel,
  type RevealLevel,
  type ChosenRunExecution,
  type ScopeNavigation,
  type WorkflowNavigation,
  type WorkflowRouteSearch,
  type WorkspaceAddress,
  type WorldCamera,
  EMPTY_SELECTION,
} from "#src/lib/workflow-navigation-state";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";

type WorkspaceRoute = { workflowId: string; search: WorkflowRouteSearch };

const workspaceRouteStateAtom = atom<WorkspaceRoute | null>(null);

/** Navigation by workflow id. */
const workflowNavigationStateAtom = atom<
  ReadonlyMap<string, WorkflowNavigation>
>(new Map());

function navigationFor(get: Getter, workflowId: string): WorkflowNavigation {
  return (
    get(workflowNavigationStateAtom).get(workflowId) ??
    EMPTY_WORKFLOW_NAVIGATION
  );
}

const writeNavigationAtom = atom(
  null,
  (
    get,
    set,
    workflowId: string,
    update: (navigation: WorkflowNavigation) => WorkflowNavigation
  ) => {
    const current = navigationFor(get, workflowId);
    const next = update(current);
    if (next !== current) {
      const state = new Map(get(workflowNavigationStateAtom));
      state.set(workflowId, next);
      set(workflowNavigationStateAtom, state);
    }
  }
);

const REVEAL_PREFERENCE_COOKIE = "sidebar-collapsed";

/**
 * Whether a person last left Canvas Reveal open or closed in a workspace that
 * does not follow its selection, kept in a cookie across reloads. A scope of
 * that workspace shown for the first time from another view starts here.
 */
const revealLevelPreferenceAtom = atom<"closed" | "browse">(
  readCookie(REVEAL_PREFERENCE_COOKIE) === "true" ? "closed" : "browse"
);

/**
 * Apply the route the router committed: the workflow in the path and its
 * validated search. Records the search as the one its view returns to. An
 * address shown for the first time stores the desktop Reveal level it
 * displays. An address whose workspace follows its selection starts closed.
 * Any other address starts at the level of the address it was reached from in
 * the same view, as a run opened from the run list, and otherwise at the
 * preference.
 */
export const applyWorkspaceRouteAtom = atom(
  null,
  (get, set, route: WorkspaceRoute) => {
    const previous = get(activeWorkspaceAddressAtom);
    const previousLevel = get(activeDesktopRevealLevelAtom);
    const preference = get(revealLevelPreferenceAtom);
    set(workspaceRouteStateAtom, route);
    const next = workspaceAddressFromSearch(route.workflowId, route.search);
    set(writeNavigationAtom, route.workflowId, (navigation) => {
      const remembered = rememberRouteSearch(navigation, next);
      if (scopeNavigationAt(remembered, next).desktop.revealLevel !== null) {
        return remembered;
      }
      const sameView =
        previous.workflowId === next.workflowId &&
        previous.key.workspace === next.key.workspace;
      const firstLevel: RevealLevel = revealFollowsSelection(next.key.workspace)
        ? "closed"
        : sameView
          ? previousLevel
          : preference;
      return updateScopeNavigation(remembered, next, (scope) =>
        withDesktopRevealLevel(scope, firstLevel)
      );
    });
  }
);

/**
 * The address the editor presents. The route names it once the route and the
 * hydrated workflow agree; until then the open workflow shows its Draft.
 */
export const activeWorkspaceAddressAtom = atom<WorkspaceAddress>((get) => {
  const workflowId = get(currentWorkflowIdAtom) ?? "";
  const route = get(workspaceRouteStateAtom);
  return workspaceAddressFromSearch(
    workflowId,
    route?.workflowId === workflowId ? route.search : {}
  );
});

/**
 * Whether the active address shows a focused Group canvas. The focused canvas
 * inserts no node and runs no layout, so every insert, paste, duplicate and
 * Tidy layout path reads this.
 */
export const groupScopeActiveAtom = atom(
  (get) => get(activeWorkspaceAddressAtom).scope.kind === "group"
);

/**
 * The route search each view of the open workflow last showed. A view with no
 * entry has not been visited in this session.
 */
export const rememberedRouteSearchesAtom = atom(
  (get): WorkflowNavigation["searches"] => {
    const workflowId = get(currentWorkflowIdAtom);
    return workflowId
      ? navigationFor(get, workflowId).searches
      : EMPTY_WORKFLOW_NAVIGATION.searches;
  }
);

/**
 * Whether a route has named a run of the open workflow in this session. The
 * value outlives the Runs panel, so a panel mounted on a return to the run
 * list sees the run that was closed there.
 */
export const hasNamedRunAtom = atom((get): boolean => {
  const workflowId = get(currentWorkflowIdAtom);
  return workflowId ? navigationFor(get, workflowId).hasNamedRun : false;
});

const activeScopeNavigationAtom = atom((get): ScopeNavigation => {
  const address = get(activeWorkspaceAddressAtom);
  return scopeNavigationAt(navigationFor(get, address.workflowId), address);
});

/**
 * The selected nodes and edges of the active address. Every canvas paints its
 * React Flow `selected` flags from this value, and writing it never touches
 * the graph, its undo history, or its save.
 */
export const activeSelectionAtom = atom(
  (get) => get(activeScopeNavigationAtom).selection,
  (get, set, selection: CanvasSelection) => {
    set(setWorkspaceSelectionAtom, {
      address: get(activeWorkspaceAddressAtom),
      selection,
    });
  }
);

/**
 * Set the selection of a named address, which need not be the active one. In a
 * workspace that follows its selection, a selection that comes to hold one
 * object opens Canvas Reveal for it.
 */
export const setWorkspaceSelectionAtom = atom(
  null,
  (
    _get,
    set,
    input: { address: WorkspaceAddress; selection: CanvasSelection }
  ) => {
    const write = revealFollowsSelection(input.address.key.workspace)
      ? withSelectionOpeningReveal
      : withSelection;
    set(writeNavigationAtom, input.address.workflowId, (navigation) =>
      updateScopeNavigation(navigation, input.address, (scope) =>
        write(scope, input.selection)
      )
    );
  }
);

/**
 * Empty the selection of every Draft and comparison address of one workflow,
 * as when its Draft graph is loaded. A run address presents the graph its run
 * pinned, so its selection stays. Takes the workflow id so a load that runs
 * before the workflow becomes the current one clears that workflow and no
 * other.
 */
export const clearDraftSelectionsAtom = atom(
  null,
  (_get, set, workflowId: string) => {
    set(writeNavigationAtom, workflowId, withoutDraftSelections);
  }
);

/**
 * The stored desktop Reveal level of the active address, before Canvas Reveal
 * applies what it is showing. An address that was never shown reads as closed
 * when its workspace follows its selection, and otherwise as the preference.
 */
export const activeDesktopRevealLevelAtom = atom((get): RevealLevel => {
  const stored = get(activeScopeNavigationAtom).desktop.revealLevel;
  if (stored !== null) {
    return stored;
  }
  return revealFollowsSelection(get(activeWorkspaceAddressAtom).key.workspace)
    ? "closed"
    : get(revealLevelPreferenceAtom);
});

/** The desktop Canvas Reveal state stored for the active address. */
export const activeRevealPresentationAtom = atom(
  (get): DesktopScopePresentation => get(activeScopeNavigationAtom).desktop
);

/**
 * A person choosing the Canvas Reveal level in a workspace that does not follow
 * its selection: it sets the active address's level, and whether that level is
 * closed becomes the preference, which the cookie keeps.
 */
export const chooseDesktopRevealLevelAtom = atom(
  null,
  (get, set, level: RevealLevel) => {
    set(setWorkspaceRevealLevelAtom, {
      address: get(activeWorkspaceAddressAtom),
      level,
    });
    set(revealLevelPreferenceAtom, level === "closed" ? "closed" : "browse");
    writeCookie(REVEAL_PREFERENCE_COOKIE, String(level === "closed"));
  }
);

/** Set the desktop Reveal level of a named address. */
export const setWorkspaceRevealLevelAtom = atom(
  null,
  (_get, set, input: { address: WorkspaceAddress; level: RevealLevel }) => {
    set(writeNavigationAtom, input.address.workflowId, (navigation) =>
      updateScopeNavigation(navigation, input.address, (scope) =>
        withDesktopRevealLevel(scope, input.level)
      )
    );
  }
);

/**
 * Record the inspector scroll of one open level for a named address. The write
 * is dropped when the address no longer inspects the node `inspectedId` names,
 * so a scroll read before a selection change never lands on the next object. A
 * null `inspectedId` is the scroll of an address that inspects no object, such
 * as a run list, a run, or a comparison.
 */
export const recordInspectorScrollAtom = atom(
  null,
  (
    _get,
    set,
    input: {
      address: WorkspaceAddress;
      inspectedId: string | null;
      level: OpenRevealLevel;
      top: number;
    }
  ) => {
    set(writeNavigationAtom, input.address.workflowId, (navigation) =>
      updateScopeNavigation(navigation, input.address, (scope) =>
        (scope.desktop.inspected?.id ?? null) === input.inspectedId
          ? withInspectorScroll(scope, input.level, input.top)
          : scope
      )
    );
  }
);

/**
 * Record the Focus section a sectioned inspector shows for a named address.
 * Like a scroll, the write is dropped when the address no longer inspects the
 * node `inspectedId` names.
 */
export const recordInspectorSectionAtom = atom(
  null,
  (
    _get,
    set,
    input: {
      address: WorkspaceAddress;
      inspectedId: string;
      section: string;
    }
  ) => {
    set(writeNavigationAtom, input.address.workflowId, (navigation) =>
      updateScopeNavigation(navigation, input.address, (scope) =>
        scope.desktop.inspected?.id === input.inspectedId
          ? withInspectorSection(scope, input.section)
          : scope
      )
    );
  }
);

/**
 * Select the node `nodeId` alone in a named address, record `section` as the
 * Focus section its inspector shows, and open Canvas Reveal at Focus. One
 * navigation write holds all three, so the selection cannot start the new
 * object's section over after the section is recorded.
 *
 * `origin` records where this jump started, for Back to return to. A call that
 * names no origin keeps the origin of a node that was already inspected, so
 * moving between that node's own sections keeps the way back.
 */
export const openInspectorSectionAtom = atom(
  null,
  (
    _get,
    set,
    input: {
      address: WorkspaceAddress;
      nodeId: string;
      section: string;
      origin?: InspectedOrigin | undefined;
    }
  ) => {
    set(writeNavigationAtom, input.address.workflowId, (navigation) =>
      updateScopeNavigation(navigation, input.address, (scope) =>
        withDesktopRevealLevel(
          withInspectorSection(selectFromOrigin(scope, input), input.section),
          "focus"
        )
      )
    );
  }
);

/**
 * Select the node `nodeId` alone in a named address, record `origin` as where
 * the jump started, and open Canvas Reveal at Browse, in one navigation write.
 */
export const openNodeRevealFromOriginAtom = atom(
  null,
  (
    _get,
    set,
    input: {
      address: WorkspaceAddress;
      nodeId: string;
      origin: InspectedOrigin;
    }
  ) => {
    set(writeNavigationAtom, input.address.workflowId, (navigation) =>
      updateScopeNavigation(navigation, input.address, (scope) =>
        withDesktopRevealLevel(selectFromOrigin(scope, input), "browse")
      )
    );
  }
);

/** Select `nodeId` alone, then record `origin` when one is named. */
function selectFromOrigin(
  scope: ScopeNavigation,
  input: {
    address: WorkspaceAddress;
    nodeId: string;
    origin?: InspectedOrigin | undefined;
  }
): ScopeNavigation {
  const select = revealFollowsSelection(input.address.key.workspace)
    ? withSelectionOpeningReveal
    : withSelection;
  const selected = select(scope, { nodeIds: [input.nodeId], edgeIds: [] });
  return input.origin === undefined
    ? selected
    : withInspectedOrigin(selected, input.origin);
}

/**
 * Open Canvas Reveal for a named address at `level`, or at the level the
 * address reopens at when `level` is absent.
 */
export const openWorkspaceRevealAtom = atom(
  null,
  (
    _get,
    set,
    input: { address: WorkspaceAddress; level?: OpenRevealLevel | undefined }
  ) => {
    set(writeNavigationAtom, input.address.workflowId, (navigation) =>
      updateScopeNavigation(navigation, input.address, (scope) =>
        withDesktopRevealLevel(scope, input.level ?? scope.desktop.reopenLevel)
      )
    );
  }
);

/** Forget the active address's inspected object when the graph lost it. */
export const keepActiveInspectionInGraphAtom = atom(
  null,
  (get, set, graph: NavigationGraph) => {
    const address = get(activeWorkspaceAddressAtom);
    set(writeNavigationAtom, address.workflowId, (navigation) =>
      updateScopeNavigation(navigation, address, (scope) =>
        inspectionInGraph(scope, graph)
      )
    );
  }
);

/**
 * Whether the active run list shows superseded runs. Each run list address
 * keeps its own value, so a return to that list restores it.
 */
export const activeShowSupersededAtom = atom(
  (get) => get(activeScopeNavigationAtom).showSuperseded,
  (get, set, showSuperseded: boolean) => {
    const address = get(activeWorkspaceAddressAtom);
    set(writeNavigationAtom, address.workflowId, (navigation) =>
      updateScopeNavigation(navigation, address, (scope) =>
        withShowSuperseded(scope, showSuperseded)
      )
    );
  }
);

/** The run node execution chosen in the active address, or null. */
export const activeChosenExecutionAtom = atom(
  (get): ChosenRunExecution | null =>
    get(activeScopeNavigationAtom).chosenExecution
);

/**
 * Show the evidence of one run node in a named run address, in one navigation
 * write. `selectsNode` selects the node alone, and otherwise the selection is
 * emptied, for a node the address's canvas cannot select. A non-null
 * `executionLogId` records that execution as the chosen one. `opensFocus` opens
 * Canvas Reveal at Focus.
 */
export const inspectRunNodeAtom = atom(
  null,
  (
    _get,
    set,
    input: {
      address: WorkspaceAddress;
      nodeId: string;
      executionLogId: string | null;
      selectsNode: boolean;
      opensFocus: boolean;
    }
  ) => {
    set(writeNavigationAtom, input.address.workflowId, (navigation) =>
      updateScopeNavigation(navigation, input.address, (scope) => {
        const selected = withSelection(
          scope,
          input.selectsNode
            ? { nodeIds: [input.nodeId], edgeIds: [] }
            : EMPTY_SELECTION
        );
        const chosen =
          input.executionLogId === null
            ? selected
            : withChosenExecution(selected, {
                nodeId: input.nodeId,
                logId: input.executionLogId,
              });
        return input.opensFocus
          ? withDesktopRevealLevel(chosen, "focus")
          : chosen;
      })
    );
  }
);

/**
 * Stop showing run node evidence in the active address: nothing is selected and
 * no execution is chosen.
 */
export const clearRunNodeInspectionAtom = atom(null, (get, set) => {
  const address = get(activeWorkspaceAddressAtom);
  set(writeNavigationAtom, address.workflowId, (navigation) =>
    updateScopeNavigation(navigation, address, (scope) =>
      withChosenExecution(withSelection(scope, EMPTY_SELECTION), null)
    )
  );
});

/**
 * Choose which recorded execution of a run node the active address shows. The
 * canvas selection is left as it is.
 */
export const chooseRunExecutionAtom = atom(
  null,
  (get, set, chosen: ChosenRunExecution) => {
    const address = get(activeWorkspaceAddressAtom);
    set(writeNavigationAtom, address.workflowId, (navigation) =>
      updateScopeNavigation(navigation, address, (scope) =>
        withChosenExecution(scope, chosen)
      )
    );
  }
);

/**
 * Close Canvas Reveal for a named address and set the level it reopens at. It
 * writes no preference cookie, for a close that undoes an opening the person
 * did not choose as a Reveal level.
 */
export const closeWorkspaceRevealAtom = atom(
  null,
  (
    _get,
    set,
    input: { address: WorkspaceAddress; reopenLevel: OpenRevealLevel }
  ) => {
    set(writeNavigationAtom, input.address.workflowId, (navigation) =>
      updateScopeNavigation(navigation, input.address, (scope) =>
        withDesktopRevealLevel(
          withDesktopRevealLevel(scope, input.reopenLevel),
          "closed"
        )
      )
    );
  }
);

/** The camera saved for each form factor of the active address. */
export const activeWorkspaceCamerasAtom = atom(
  (get): Readonly<Record<FormFactor, WorldCamera | null>> => {
    const scope = get(activeScopeNavigationAtom);
    return { desktop: scope.desktop.camera, mobile: scope.mobile.camera };
  }
);

/** Store the camera one form factor showed for a named address. */
export const recordWorkspaceCameraAtom = atom(
  null,
  (
    _get,
    set,
    input: {
      address: WorkspaceAddress;
      formFactor: FormFactor;
      camera: WorldCamera;
    }
  ) => {
    set(writeNavigationAtom, input.address.workflowId, (navigation) =>
      updateScopeNavigation(navigation, input.address, (scope) =>
        withCamera(scope, input.formFactor, input.camera)
      )
    );
  }
);

/**
 * Clear the cameras saved for the focused Group `groupId` of one workflow's
 * Draft and comparison keys, as when the Group's layout direction changed.
 */
export const forgetGroupCamerasAtom = atom(
  null,
  (_get, set, input: { workflowId: string; groupId: string }) => {
    set(writeNavigationAtom, input.workflowId, (navigation) =>
      withoutGroupCameras(navigation, input.groupId)
    );
  }
);

/** Drop everything remembered for a workflow, as when it is deleted. */
export const forgetWorkflowNavigationAtom = atom(
  null,
  (get, set, workflowId: string) => {
    const state = get(workflowNavigationStateAtom);
    if (state.has(workflowId)) {
      const next = new Map(state);
      next.delete(workflowId);
      set(workflowNavigationStateAtom, next);
    }
  }
);
