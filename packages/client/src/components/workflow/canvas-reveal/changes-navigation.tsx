/**
 * How both Changes bodies move between changed objects: the comparison's change
 * list with the selected entry, and the Previous and Next bar. Choosing an entry
 * writes the canvas selection, which both bodies and the camera follow. A step
 * inside a collapsed Group is selected on that Group's focused canvas, and
 * Previous and Next reach it by replacing the route's history entry.
 */

import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom, useStore } from "jotai";
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
  type WorkspaceScope,
} from "#src/lib/workflow-navigation-state";
import {
  activeDesktopRevealLevelAtom,
  activeRevealPresentationAtom,
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
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

/** How selecting a changed object in another scope writes the route. */
export type SelectChangeOptions = {
  /** Replace the current history entry, for a step through the list. */
  replace?: boolean | undefined;
};

/**
 * The changed objects of `payload` on the comparison canvas, the index and key
 * of the selected one (-1 and null when the selection holds none of them), and
 * `select`, which selects one object on the canvas.
 */
export function useChangedObjects(payload: WorkflowComparisonPayload): {
  objects: readonly ChangedObject[];
  selectedIndex: number;
  selectedKey: string | null;
  select: (
    item: ChangedObject | undefined,
    options?: SelectChangeOptions
  ) => void;
} {
  const catalog = useExtensionCatalog();
  const graph = useAtomValue(comparisonDisplayGraphAtom);
  const selection = useAtomValue(activeSelectionAtom);
  const selectChange = useSelectChange();
  const objects = useMemo(
    () => (graph ? changedObjects({ payload, graph, catalog }) : []),
    [catalog, graph, payload]
  );
  const selectedIndex = selectedChangeIndex(objects, selection);
  return {
    objects,
    selectedIndex,
    selectedKey: objects[selectedIndex]?.key ?? null,
    select: (item, options) => {
      if (item) {
        selectChange(item, options);
      }
    },
  };
}

/**
 * Select one changed object in the scope that shows it. A node inside a Group
 * frame shows on that Group's focused canvas, and every other node and every
 * connection on the overview. Reaching the other scope pushes its route, or
 * replaces it with `options.replace`, keeps the Reveal level showing now, and
 * asks the camera to place the object there. From Focus it also carries the
 * change list's scroll to the other scope, so Back shows the list where Focus
 * was entered.
 */
function useSelectChange(): (
  item: ChangedObject,
  options?: SelectChangeOptions
) => void {
  const store = useStore();
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  const setSelection = useSetAtom(setWorkspaceSelectionAtom);
  const setRevealLevel = useSetAtom(setWorkspaceRevealLevelAtom);
  const requestPlacement = useSetAtom(requestRevealPlacementAtom);
  const recordScroll = useSetAtom(recordInspectorScrollAtom);
  return (item, options) => {
    const active = store.get(activeWorkspaceAddressAtom);
    const nodes = store.get(comparisonDisplayGraphAtom)?.nodes ?? [];
    const scope: WorkspaceScope =
      item.object.kind === "node"
        ? scopeOfNode(nodes, item.object.id)
        : { kind: "overview" };
    const selection = changeSelection(item.object);
    if (scopeId(scope) === scopeId(active.scope)) {
      setSelection({ address: active, selection });
      return;
    }
    const target = { ...active, scope };
    const level = store.get(activeDesktopRevealLevelAtom);
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
    if (item.object.kind === "node") {
      requestPlacement({
        addressId: workspaceAddressId(target),
        nodeIds: [item.object.id],
      });
    }
    void navigate({
      search: workspaceRouteSearch(target),
      replace: options?.replace ?? false,
    });
  };
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
