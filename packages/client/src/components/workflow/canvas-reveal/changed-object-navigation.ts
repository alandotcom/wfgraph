/**
 * How a changed object of the active comparison is shown in the scope that
 * shows it: selected on the desktop canvas, or opened as field differences in
 * the mobile Reveal sequence. The Changes bodies and `useRevealNavigation` both
 * call it, so it imports no React component.
 */

import type { RegisteredRouter, useNavigate } from "@tanstack/react-router";
import type { createStore } from "jotai";
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
import { requestRevealPlacementAtom } from "./reveal-requests";

/** How selecting a changed object writes the route and Reveal. */
export type SelectChangeOptions = {
  /** Replace the current history entry, for a step through the list. */
  replace?: boolean | undefined;
  /** Open Reveal at Browse when it is closed, so the object's comparison shows. */
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
  store: ReturnType<typeof createStore>,
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
 * Show the field differences of the changed object `object` in the mobile
 * Reveal sequence of the scope that shows it, through `openMobileChangeAtom`.
 * Reaching another scope writes that scope's sequence, then pushes its route,
 * or replaces it with `options.replace`.
 */
export function openMobileChangedObject(
  input: {
    store: ReturnType<typeof createStore>;
    navigate: EditorNavigate;
    object: InspectedObject;
  },
  options?: SelectChangeOptions
): void {
  const { store, navigate, object } = input;
  const active = store.get(activeWorkspaceAddressAtom);
  const scope = changedObjectScope(store, object);
  const target = { ...active, scope };
  store.set(openMobileChangeAtom, { address: target, inspected: object });
  if (scopeId(scope) !== scopeId(active.scope)) {
    void navigate({
      search: workspaceRouteSearch(target),
      replace: options?.replace ?? false,
    });
  }
}

/**
 * Select one changed object in the scope that shows it. A node inside a Group
 * frame, or a connection between two of its members, shows on that Group's
 * focused canvas, and every other node and connection on the overview.
 * Reaching the other scope pushes its route, or replaces it with
 * `options.replace`, keeps the Reveal level showing now, or Browse for a closed
 * Reveal with `options.openReveal`, and asks the camera to place the object
 * there. From Focus it also carries the change list's scroll
 * to the other scope, so Back shows the list where Focus was entered.
 */
export function selectChangedObject(
  input: {
    store: ReturnType<typeof createStore>;
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
  if (level === "focus") {
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
  void navigate({
    search: workspaceRouteSearch(target),
    replace: options?.replace ?? false,
  });
}
