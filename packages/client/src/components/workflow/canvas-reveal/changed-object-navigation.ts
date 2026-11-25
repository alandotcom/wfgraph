/**
 * How a changed object of the active comparison is shown in the scope that
 * shows it: selected on the desktop canvas, or selected in the phone's change
 * list sheet. Either way the change list opens the object's row. The Changes
 * bodies and `useRevealNavigation` both call it, so it renders nothing itself.
 */

import type { RegisteredRouter, useNavigate } from "@tanstack/react-router";
import type { Store } from "jotai";
import { openMobileChangeAtom } from "#src/lib/mobile-sheet-store";
import { comparisonDisplayGraphAtom } from "#src/lib/workflow-comparison-store";
import {
  scopeId,
  workspaceAddressId,
  workspaceRouteSearch,
  type CanvasSelection,
  type InspectedObject,
  type WorkspaceScope,
} from "#src/lib/workflow-navigation-state";
import { scopeOfEdge, scopeOfNode } from "#src/lib/workflow-scope-graph";
import {
  activeDesktopRevealLevelAtom,
  activeRevealPresentationAtom,
  activeWorkspaceAddressAtom,
  recordInspectorScrollAtom,
  setWorkspaceRevealLevelAtom,
  setWorkspaceSelectionAtom,
} from "#src/lib/workflow-workspace-navigation";
import { CHANGE_LIST_SECTION } from "./changes-summary";
import { requestRevealPlacementAtom } from "./reveal-requests";

/** How selecting a changed object writes Reveal. */
type SelectChangeOptions = {
  /** Open Reveal at Browse when it is closed, so the object's row shows. */
  openReveal?: boolean | undefined;
};

/** The editor route's navigate function, which writes the route search. */
type EditorNavigate = ReturnType<
  typeof useNavigate<RegisteredRouter, "/workflows/$workflowId">
>;

/** The selection holding only one changed object. */
function changeSelection(object: InspectedObject): CanvasSelection {
  return object.kind === "node"
    ? { nodeIds: [object.id], edgeIds: [] }
    : { nodeIds: [], edgeIds: [object.id] };
}

/**
 * The scope of the comparison canvas that shows `object`: the focused canvas
 * of the Group frame holding a node or both ends of a connection, and the
 * overview for every other node and connection.
 */
function changedObjectScope(
  store: Store,
  object: InspectedObject
): WorkspaceScope {
  const graph = store.get(comparisonDisplayGraphAtom);
  const nodes = graph?.nodes ?? [];
  if (object.kind === "node") {
    return scopeOfNode(nodes, object.id);
  }
  const edge = graph?.edges.find((item) => item.id === object.id);
  return edge ? scopeOfEdge(nodes, edge) : { kind: "overview" };
}

/**
 * Select the changed object `object` in the phone's change list sheet of the
 * scope that shows it, through `openMobileChangeAtom`. Reaching another scope
 * writes that scope's sheets, then pushes its route.
 */
export function openMobileChangedObject(input: {
  store: Store;
  navigate: EditorNavigate;
  object: InspectedObject;
}): void {
  const { store, navigate, object } = input;
  const active = store.get(activeWorkspaceAddressAtom);
  const scope = changedObjectScope(store, object);
  const target = { ...active, scope };
  store.set(openMobileChangeAtom, {
    address: target,
    inspected: object,
    section: CHANGE_LIST_SECTION,
  });
  if (scopeId(scope) !== scopeId(active.scope)) {
    void navigate({ search: workspaceRouteSearch(target) });
  }
}

/**
 * Select one changed object in the scope that shows it. A node inside a Group
 * frame, or a connection between two of its members, shows on that Group's
 * focused canvas, and every other node and connection on the overview.
 * Reaching the other scope pushes its route, keeps the Reveal level showing
 * now, or Browse for a closed Reveal with `options.openReveal`, carries the
 * change list's scroll there, and asks the camera to place the object. The
 * change list then opens the object's row and scrolls it into view.
 */
export function selectChangedObject(
  input: {
    store: Store;
    navigate: EditorNavigate;
    object: InspectedObject;
  },
  options?: SelectChangeOptions
): void {
  const { store, navigate, object } = input;
  const active = store.get(activeWorkspaceAddressAtom);
  const scope = changedObjectScope(store, object);
  const selection = changeSelection(object);
  const shownLevel = store.get(activeDesktopRevealLevelAtom);
  const level =
    options?.openReveal && shownLevel === "closed" ? "browse" : shownLevel;
  if (scopeId(scope) === scopeId(active.scope)) {
    store.set(setWorkspaceSelectionAtom, { address: active, selection });
    if (level !== shownLevel) {
      store.set(setWorkspaceRevealLevelAtom, { address: active, level });
    }
    return;
  }
  const target = { ...active, scope };
  store.set(setWorkspaceSelectionAtom, { address: target, selection });
  store.set(setWorkspaceRevealLevelAtom, { address: target, level });
  if (shownLevel !== "closed") {
    store.set(recordInspectorScrollAtom, {
      address: target,
      inspectedId: null,
      level: "browse",
      top: store.get(activeRevealPresentationAtom).inspectorScroll.browse,
    });
  }
  if (object.kind === "node") {
    store.set(requestRevealPlacementAtom, {
      addressId: workspaceAddressId(target),
      nodeIds: [object.id],
    });
  }
  void navigate({ search: workspaceRouteSearch(target) });
}
