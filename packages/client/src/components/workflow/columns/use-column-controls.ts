import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useDomEvent } from "#src/hooks/effects";
import { editorChordAllowed } from "#src/lib/editor-shortcuts";
import { COLUMN_SHORTCUT_KEYS } from "#src/lib/shortcut-label";
import {
  type ColumnShape,
  type ColumnSide,
  columnPreferencesAtom,
  columnShapes,
  detailsFloatOpenAtom,
  detailsToggle,
  outlineFilterFocusRequestAtom,
  phoneShowsMapAtom,
  setColumnCollapsedAtom,
} from "./editor-columns-store";
import { useEditorLayout } from "./use-editor-layout";

export type ColumnControls = {
  shapes: Record<ColumnSide, ColumnShape>;
  /** What the column's control, shortcut and command do now, in words. */
  toggleLabel: (side: ColumnSide) => string;
  toggle: (side: ColumnSide) => void;
  /** Close details floating over the canvas. */
  closeDetailsFloat: () => void;
  /** Whether the outline is on screen: docked, or a phone's main view. */
  outlineShown: boolean;
  /**
   * Bring the outline into view, docking it or leaving a phone's map, and put
   * the cursor in its "Filter steps" field.
   */
  findStep: () => void;
};

const DETAILS_LABELS: Record<ReturnType<typeof detailsToggle>, string> = {
  collapse: "Collapse details",
  dock: "Show details",
  float: "Show details",
  "close-float": "Close details",
};

/**
 * What each side column shows at the viewport's width, and the one action its
 * control, its shortcut and its palette command share. The outline collapses
 * to a rail and comes back. Details does the same at 1360px and wider; from
 * 900px to 1359px it opens and closes over the right of the canvas.
 */
export function useColumnControls(): ColumnControls {
  const layout = useEditorLayout();
  const preferences = useAtomValue(columnPreferencesAtom);
  const [detailsFloatOpen, setDetailsFloatOpen] = useAtom(detailsFloatOpenAtom);
  const setCollapsed = useSetAtom(setColumnCollapsedAtom);
  const [phoneShowsMap, setPhoneShowsMap] = useAtom(phoneShowsMapAtom);
  const requestFilterFocus = useSetAtom(outlineFilterFocusRequestAtom);
  const shapes = columnShapes({ layout, preferences, detailsFloatOpen });
  const detailsAction = detailsToggle({ layout, shape: shapes.details });
  const outlineShown =
    layout === "compact" ? !phoneShowsMap : shapes.outline !== "rail";

  const toggle = (side: ColumnSide) => {
    if (side === "outline") {
      setCollapsed({ side, collapsed: shapes.outline === "docked" });
      return;
    }
    if (detailsAction === "collapse" || detailsAction === "dock") {
      setDetailsFloatOpen(false);
      setCollapsed({ side, collapsed: detailsAction === "collapse" });
      return;
    }
    setDetailsFloatOpen(detailsAction === "float");
  };

  const toggleLabel = (side: ColumnSide) => {
    if (side === "outline") {
      return shapes.outline === "docked" ? "Collapse outline" : "Show outline";
    }
    return DETAILS_LABELS[detailsAction];
  };

  const findStep = () => {
    if (layout === "compact") {
      setPhoneShowsMap(false);
    } else if (shapes.outline === "rail") {
      setCollapsed({ side: "outline", collapsed: false });
    }
    requestFilterFocus((count) => count + 1);
  };

  return {
    shapes,
    toggle,
    toggleLabel,
    closeDetailsFloat: () => setDetailsFloatOpen(false),
    outlineShown,
    findStep,
  };
}

/**
 * Cmd+F or Ctrl+F while the outline is out of view brings it back and puts the
 * cursor in its filter field. While the outline is on screen it answers the
 * chord itself.
 */
export function useFindStepShortcut(controls: ColumnControls): void {
  useDomEvent(document, "keydown", (event) => {
    if (
      controls.outlineShown ||
      event.key.toLowerCase() !== "f" ||
      !(event.metaKey || event.ctrlKey) ||
      event.altKey ||
      event.shiftKey ||
      !editorChordAllowed(event, { inTextFields: true })
    ) {
      return;
    }
    event.preventDefault();
    controls.findStep();
  });
}

/**
 * `[` and `]` collapse and show the outline and details from anywhere in the
 * editor but a text field, an open dialog or menu, or with a modifier held.
 */
export function useColumnShortcuts(
  controls: ColumnControls,
  options: { enabled: boolean }
): void {
  useDomEvent(
    document,
    "keydown",
    (event) => {
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.defaultPrevented ||
        !editorChordAllowed(event, { inTextFields: false })
      ) {
        return;
      }
      const side =
        event.key === COLUMN_SHORTCUT_KEYS.outline
          ? "outline"
          : event.key === COLUMN_SHORTCUT_KEYS.details
            ? "details"
            : null;
      if (side === null) {
        return;
      }
      event.preventDefault();
      controls.toggle(side);
    },
    { enabled: options.enabled }
  );
}
