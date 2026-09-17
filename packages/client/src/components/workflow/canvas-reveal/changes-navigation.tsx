/**
 * How both Changes bodies move between changed objects: the comparison's change
 * list with the selected entry, and the Previous and Next bar. Choosing an entry
 * writes the canvas selection, which both bodies and the camera follow. A step
 * inside a collapsed Group is selected on that Group's focused canvas, and
 * Previous and Next reach it by replacing the route's history entry. A
 * collapsed Group card leads to the changed steps inside it the same way.
 */

import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom, useStore, type createStore } from "jotai";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useMemo } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { Button } from "#src/components/ui/button";
import { comparisonDisplayGraphAtom } from "#src/lib/workflow-comparison-store";
import {
  scopeId,
  scopeOfNode,
  workspaceAddressId,
  workspaceRouteSearch,
  type InspectedObject,
  type WorkspaceScope,
} from "#src/lib/workflow-navigation-state";
import {
  activeDesktopRevealLevelAtom,
  activeRevealPresentationAtom,
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
  openMobileChangeAtom,
  recordInspectorScrollAtom,
  setWorkspaceRevealLevelAtom,
  setWorkspaceSelectionAtom,
} from "#src/lib/workflow-workspace-navigation";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import {
  changedObjects,
  changeSelection,
  selectedChangeIndex,
  type ChangedObject,
} from "./changes-summary";
import { requestRevealPlacementAtom } from "./reveal-requests";

/** How selecting a changed object writes the route and Reveal. */
export type SelectChangeOptions = {
  /** Replace the current history entry, for a step through the list. */
  replace?: boolean | undefined;
  /** Open Reveal at Browse when it is closed, so the object's comparison shows. */
  openReveal?: boolean | undefined;
};

/** Choose one changed object, doing nothing for an undefined one. */
export type ChooseChange = (
  item: ChangedObject | undefined,
  options?: SelectChangeOptions
) => void;

/**
 * The changed objects of `payload` on the comparison canvas, and the index and
 * key of the selected one (-1 and null when the selection holds none of them).
 */
export function useChangedObjects(payload: WorkflowComparisonPayload): {
  objects: readonly ChangedObject[];
  selectedIndex: number;
  selectedKey: string | null;
} {
  const catalog = useExtensionCatalog();
  const graph = useAtomValue(comparisonDisplayGraphAtom);
  const selection = useAtomValue(activeSelectionAtom);
  const objects = useMemo(
    () => (graph ? changedObjects({ payload, graph, catalog }) : []),
    [catalog, graph, payload]
  );
  const selectedIndex = selectedChangeIndex(objects, selection);
  return {
    objects,
    selectedIndex,
    selectedKey: objects[selectedIndex]?.key ?? null,
  };
}

/**
 * Select a changed object on the canvas, as `useSelectChangedObject`
 * describes, which Canvas Reveal's Browse and Focus follow.
 */
export function useSelectChange(): ChooseChange {
  const selectChange = useSelectChangedObject();
  return (item, options) => {
    if (item) {
      selectChange(item.object, options);
    }
  };
}

/**
 * The scope of the comparison canvas that shows `object`: the focused canvas
 * of the Group frame holding a node, and the overview for every other node and
 * every connection.
 */
function changedObjectScope(
  store: ReturnType<typeof createStore>,
  object: InspectedObject
): WorkspaceScope {
  const nodes = store.get(comparisonDisplayGraphAtom)?.nodes ?? [];
  return object.kind === "node"
    ? scopeOfNode(nodes, object.id)
    : { kind: "overview" };
}

/**
 * Show the field differences of a changed object in the mobile Reveal sequence
 * of the scope that shows it, through `openMobileChangeAtom`. Reaching another
 * scope writes that scope's sequence, then pushes its route, or replaces it
 * with `options.replace`.
 */
export function useOpenMobileChange(): ChooseChange {
  const store = useStore();
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  const openChange = useSetAtom(openMobileChangeAtom);
  return (item, options) => {
    if (!item) {
      return;
    }
    const active = store.get(activeWorkspaceAddressAtom);
    const scope = changedObjectScope(store, item.object);
    const target = { ...active, scope };
    openChange({ address: target, inspected: item.object });
    if (scopeId(scope) !== scopeId(active.scope)) {
      void navigate({
        search: workspaceRouteSearch(target),
        replace: options?.replace ?? false,
      });
    }
  };
}

/**
 * Select one changed object in the scope that shows it. A node inside a Group
 * frame shows on that Group's focused canvas, and every other node and every
 * connection on the overview. Reaching the other scope pushes its route, or
 * replaces it with `options.replace`, keeps the Reveal level showing now, or
 * Browse for a closed Reveal with `options.openReveal`, and asks the camera to
 * place the object there. From Focus it also carries the change list's scroll
 * to the other scope, so Back shows the list where Focus was entered.
 */
function useSelectChangedObject(): (
  object: InspectedObject,
  options?: SelectChangeOptions
) => void {
  const store = useStore();
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  const setSelection = useSetAtom(setWorkspaceSelectionAtom);
  const setRevealLevel = useSetAtom(setWorkspaceRevealLevelAtom);
  const requestPlacement = useSetAtom(requestRevealPlacementAtom);
  const recordScroll = useSetAtom(recordInspectorScrollAtom);
  return (object, options) => {
    const active = store.get(activeWorkspaceAddressAtom);
    const scope = changedObjectScope(store, object);
    const selection = changeSelection(object);
    const shownLevel = store.get(activeDesktopRevealLevelAtom);
    const level =
      options?.openReveal && shownLevel === "closed" ? "browse" : shownLevel;
    if (scopeId(scope) === scopeId(active.scope)) {
      setSelection({ address: active, selection });
      if (level !== shownLevel) {
        setRevealLevel({ address: active, level });
      }
      return;
    }
    const target = { ...active, scope };
    setSelection({ address: target, selection });
    setRevealLevel({ address: target, level });
    if (level === "focus") {
      recordScroll({
        address: target,
        inspectedId: null,
        level: "browse",
        top: store.get(activeRevealPresentationAtom).inspectorScroll.browse,
      });
    }
    if (object.kind === "node") {
      requestPlacement({
        addressId: workspaceAddressId(target),
        nodeIds: [object.id],
      });
    }
    void navigate({
      search: workspaceRouteSearch(target),
      replace: options?.replace ?? false,
    });
  };
}

/**
 * The control on a collapsed Group card that counts the changed steps inside
 * the Group. Pressing it enters the Group and selects the first of them,
 * opening Reveal at Browse when it is closed, so that step's comparison shows.
 */
export function GroupChangedStepsButton({
  groupLabel,
  changedMemberIds,
}: {
  groupLabel: string;
  changedMemberIds: readonly string[];
}) {
  const selectChange = useSelectChangedObject();
  const count = changedMemberIds.length;
  const firstId = changedMemberIds[0];
  if (firstId === undefined) {
    return null;
  }
  return (
    <Button
      aria-label={`Show ${count} changed ${count === 1 ? "step" : "steps"} in group ${groupLabel}`}
      // `nodrag` keeps a press on the button from starting a drag or selecting
      // the card underneath it.
      className="nodrag nopan h-6 px-2 text-xs"
      data-slot="group-changed-steps"
      onClick={(event) => {
        event.stopPropagation();
        selectChange({ kind: "node", id: firstId }, { openReveal: true });
      }}
      size="sm"
      type="button"
      variant="outline"
    >
      {count} changed
    </Button>
  );
}

/**
 * Previous, the selected object's place in the list, and Next. With nothing in
 * the list selected, Next selects the first change. Each step replaces the
 * route's history entry when it reaches another scope.
 */
export function ChangeNavigation({
  objects,
  selectedIndex,
  onSelect,
}: {
  objects: readonly ChangedObject[];
  selectedIndex: number;
  onSelect: (
    item: ChangedObject | undefined,
    options: SelectChangeOptions
  ) => void;
}) {
  return (
    <nav
      aria-label="Changed objects"
      className="flex shrink-0 items-center justify-between border-t px-2 py-1.5"
    >
      <Button
        aria-label="Previous change"
        disabled={selectedIndex <= 0}
        onClick={() => onSelect(objects[selectedIndex - 1], { replace: true })}
        size="sm"
        type="button"
        variant="ghost"
      >
        <ArrowLeft data-icon="inline-start" />
        Previous
      </Button>
      <span className="text-muted-foreground text-xs">
        {selectedIndex >= 0
          ? `${selectedIndex + 1} of ${objects.length}`
          : `${objects.length} ${objects.length === 1 ? "change" : "changes"}`}
      </span>
      <Button
        aria-label="Next change"
        disabled={selectedIndex >= objects.length - 1}
        onClick={() => onSelect(objects[selectedIndex + 1], { replace: true })}
        size="sm"
        type="button"
        variant="ghost"
      >
        Next
        <ArrowRight data-icon="inline-end" />
      </Button>
    </nav>
  );
}
