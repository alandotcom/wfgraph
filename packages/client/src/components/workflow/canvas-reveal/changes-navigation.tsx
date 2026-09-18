/**
 * How both Changes bodies move between changed objects: the comparison's change
 * list with the selected entry, and the Previous and Next bar. Choosing an entry
 * writes the canvas selection, which both bodies and the camera follow. A step
 * inside a collapsed Group is selected on that Group's focused canvas, and
 * Previous and Next reach it by replacing the route's history entry. A
 * collapsed Group card leads to the changed steps inside it the same way.
 */

import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useStore } from "jotai";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useMemo } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { Button } from "#src/components/ui/button";
import { comparisonDisplayGraphAtom } from "#src/lib/workflow-comparison-store";
import type { InspectedObject } from "#src/lib/workflow-navigation-state";
import { activeSelectionAtom } from "#src/lib/workflow-workspace-navigation";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import {
  openMobileChangedObject,
  selectChangedObject,
  type SelectChangeOptions,
} from "./changed-object-navigation";
import {
  changedObjects,
  selectedChangeIndex,
  type ChangedObject,
} from "./changes-summary";
import { useRevealNavigation } from "./use-reveal-navigation";

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
 * Show the field differences of a changed object in the mobile Reveal sequence
 * of the scope that shows it, through `openMobileChangeAtom`. Reaching another
 * scope writes that scope's sequence, then pushes its route, or replaces it
 * with `options.replace`.
 */
export function useOpenMobileChange(): ChooseChange {
  const openChangedObject = useOpenMobileChangedObject();
  return (item, options) => {
    if (item) {
      openChangedObject(item.object, options);
    }
  };
}

function useOpenMobileChangedObject(): (
  object: InspectedObject,
  options?: SelectChangeOptions
) => void {
  const store = useStore();
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  return (object, options) =>
    openMobileChangedObject({ store, navigate, object }, options);
}

function useSelectChangedObject(): (
  object: InspectedObject,
  options?: SelectChangeOptions
) => void {
  const store = useStore();
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  return (object, options) =>
    selectChangedObject({ store, navigate, object }, options);
}

/**
 * The control on a collapsed Group card that counts the changed steps inside
 * the Group. Pressing it enters the Group and shows the first of them through
 * `RevealNavigation.showChangedObject`.
 */
export function GroupChangedStepsButton({
  groupLabel,
  changedMemberIds,
}: {
  groupLabel: string;
  changedMemberIds: readonly string[];
}) {
  const navigation = useRevealNavigation();
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
        navigation.showChangedObject({ kind: "node", id: firstId });
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
