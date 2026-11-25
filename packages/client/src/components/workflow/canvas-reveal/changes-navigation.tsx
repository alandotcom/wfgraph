/**
 * How the Changes change list moves between changed objects and which of its
 * rows are open. Choosing an object writes the canvas selection, which the list
 * and the camera follow. A step inside a collapsed Group is selected on that
 * Group's focused canvas, and a collapsed Group card's changed count leads to
 * the changed steps inside it the same way.
 */

import { useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomValue, useStore } from "jotai";
import { useMemo } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { Button } from "#src/components/ui/button";
import { comparisonDisplayGraphAtom } from "#src/lib/workflow-comparison-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { activeSelectionAtom } from "#src/lib/workflow-workspace-navigation";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import {
  openMobileChangedObject,
  selectChangedObject,
} from "./changed-object-navigation";
import {
  changedObjects,
  changeRowsComparisonKey,
  initiallyOpenChangeRows,
  openChangeRowsAtom,
  opensInPlace,
  selectedChangeIndex,
  type ChangedObject,
} from "./changes-summary";
import { useRevealNavigation } from "./use-reveal-navigation";

/** Choose one changed object of the change list. */
export type ChooseChange = (item: ChangedObject) => void;

/**
 * The changed objects of `payload` on the comparison canvas, and the key of
 * the selected one (null when the selection holds none of them).
 */
export function useChangedObjects(payload: WorkflowComparisonPayload): {
  objects: readonly ChangedObject[];
  selectedKey: string | null;
} {
  const catalog = useExtensionCatalog();
  const graph = useAtomValue(comparisonDisplayGraphAtom);
  const selection = useAtomValue(activeSelectionAtom);
  const objects = useMemo(
    () => (graph ? changedObjects({ payload, graph, catalog }) : []),
    [catalog, graph, payload]
  );
  return {
    objects,
    selectedKey: objects[selectedChangeIndex(objects, selection)]?.key ?? null,
  };
}

/**
 * Select a changed object on the canvas, as `selectChangedObject` describes,
 * which the change list follows by opening that object's row.
 */
export function useSelectChange(): ChooseChange {
  const store = useStore();
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  return (item) =>
    selectChangedObject({ store, navigate, object: item.object });
}

/**
 * Select a changed object in the phone's change list sheet of the scope that
 * shows it, as `openMobileChangedObject` describes.
 */
export function useOpenMobileChange(): ChooseChange {
  const store = useStore();
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  return (item) =>
    openMobileChangedObject({ store, navigate, object: item.object });
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
 * The open rows of the change list of `payload`, and the writes that change
 * them. Until the reader or a selection first opens or closes a row of this
 * comparison, the list shows `initiallyOpenChangeRows`. `toggle` opens or
 * closes a row. `reveal` records `item` as the selected object the list has
 * shown, as `revealed`, and opens its row when it has one; null records that
 * no changed object is selected. Neither moves the camera or the selection.
 */
export function useOpenChangeRows(
  payload: WorkflowComparisonPayload,
  objects: readonly ChangedObject[]
): {
  open: ReadonlySet<string>;
  revealed: string | null;
  toggle: (key: string) => void;
  reveal: (item: ChangedObject | null) => void;
} {
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const [stored, setStored] = useAtom(openChangeRowsAtom);
  const comparison = changeRowsComparisonKey(workflowId, payload);
  const current = stored?.comparison === comparison ? stored : null;
  const initial = useMemo(() => initiallyOpenChangeRows(objects), [objects]);
  const open = current?.keys ?? initial;
  const revealed = current?.revealed ?? null;
  return {
    open,
    revealed,
    toggle: (key) => {
      const keys = new Set(open);
      if (!keys.delete(key)) {
        keys.add(key);
      }
      setStored({ comparison, keys, revealed });
    },
    reveal: (item) =>
      setStored({
        comparison,
        keys: item && opensInPlace(item) ? new Set([...open, item.key]) : open,
        revealed: item?.key ?? null,
      }),
  };
}
