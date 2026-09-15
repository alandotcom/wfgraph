/**
 * The workspace address the editor route names, and the navigation each
 * address remembers. The route is the system of record for the active address;
 * the selection, Reveal level, and cameras stored here per address are the
 * system of record for those values. The UI and graph stores read this module.
 */

import { atom, type Getter } from "jotai";
import { readCookie, writeCookie } from "#src/lib/preference-cookies";
import {
  EMPTY_WORKFLOW_NAVIGATION,
  rememberRouteSearch,
  scopeNavigationAt,
  updateScopeNavigation,
  withCamera,
  withDesktopRevealLevel,
  withSelection,
  withoutDraftSelections,
  workspaceAddressFromSearch,
  type CanvasSelection,
  type FormFactor,
  type RevealLevel,
  type ScopeNavigation,
  type WorkflowNavigation,
  type WorkflowRouteSearch,
  type WorkspaceAddress,
  type WorldCamera,
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
 * The desktop Reveal level a person last chose, kept in a cookie across
 * reloads. A scope shown for the first time from another view starts here.
 */
const revealLevelPreferenceAtom = atom<RevealLevel>(
  readCookie(REVEAL_PREFERENCE_COOKIE) === "true" ? "closed" : "browse"
);

/**
 * Apply the route the router committed: the workflow in the path and its
 * validated search. Records the search as the one its view returns to. An
 * address shown for the first time stores the desktop Reveal level it
 * displays: the level of the address it was reached from when both belong to
 * one view, as a run opened from the run list, and otherwise the preference.
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
      return updateScopeNavigation(remembered, next, (scope) =>
        withDesktopRevealLevel(scope, sameView ? previousLevel : preference)
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

/** Set the selection of a named address, which need not be the active one. */
export const setWorkspaceSelectionAtom = atom(
  null,
  (
    _get,
    set,
    input: { address: WorkspaceAddress; selection: CanvasSelection }
  ) => {
    set(writeNavigationAtom, input.address.workflowId, (navigation) =>
      updateScopeNavigation(navigation, input.address, (scope) =>
        withSelection(scope, input.selection)
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
 * The desktop Reveal level of the active address. An address that was never
 * shown reads as the preference.
 */
export const activeDesktopRevealLevelAtom = atom(
  (get): RevealLevel =>
    get(activeScopeNavigationAtom).desktop.revealLevel ??
    get(revealLevelPreferenceAtom)
);

/**
 * A person choosing the desktop Reveal level: it sets the active address's
 * level and becomes the preference, which the cookie keeps.
 */
export const chooseDesktopRevealLevelAtom = atom(
  null,
  (get, set, level: RevealLevel) => {
    set(setWorkspaceRevealLevelAtom, {
      address: get(activeWorkspaceAddressAtom),
      level,
    });
    set(revealLevelPreferenceAtom, level);
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
