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
  withInspectorScroll,
  withRevealCamera,
  withSelection,
  withSelectionOpeningReveal,
  withoutDraftSelections,
  workspaceAddressFromSearch,
  type CanvasSelection,
  type DesktopScopePresentation,
  type FormFactor,
  type NavigationGraph,
  type OpenRevealLevel,
  type RevealCamera,
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
 * so a scroll read before a selection change never lands on the next object.
 */
export const recordInspectorScrollAtom = atom(
  null,
  (
    _get,
    set,
    input: {
      address: WorkspaceAddress;
      inspectedId: string;
      level: OpenRevealLevel;
      top: number;
    }
  ) => {
    set(writeNavigationAtom, input.address.workflowId, (navigation) =>
      updateScopeNavigation(navigation, input.address, (scope) =>
        scope.desktop.inspected?.id === input.inspectedId
          ? withInspectorScroll(scope, input.level, input.top)
          : scope
      )
    );
  }
);

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

/** Store or clear the automatic Reveal placement of a named address. */
export const setRevealCameraAtom = atom(
  null,
  (
    _get,
    set,
    input: { address: WorkspaceAddress; revealCamera: RevealCamera | null }
  ) => {
    set(writeNavigationAtom, input.address.workflowId, (navigation) =>
      updateScopeNavigation(navigation, input.address, (scope) =>
        withRevealCamera(scope, input.revealCamera)
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
