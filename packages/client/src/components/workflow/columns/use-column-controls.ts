import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useDomEvent } from "#src/hooks/effects";
import { editorChordAllowed } from "#src/lib/editor-shortcuts";
import { COLUMN_SHORTCUT_KEYS } from "#src/lib/shortcut-label";
import {
  type ColumnShape,
  type ColumnSide,
  columnPreferencesAtom,
  columnShapes,
  outlineOverlayOpenAtom,
  outlineToggle,
  setColumnCollapsedAtom,
} from "./editor-columns-store";
import { useEditorLayout } from "./use-editor-layout";

export type ColumnControls = {
  shapes: Record<ColumnSide, ColumnShape>;
  /** What the column's control, shortcut and command do now, in words. */
  toggleLabel: (side: ColumnSide) => string;
  toggle: (side: ColumnSide) => void;
  /** Close the outline shown over the canvas, when it shows there. */
  closeOutlineOverlay: () => void;
};

/**
 * What each side column shows at the viewport's width, and the one action its
 * collapse control, its shortcut and its palette command share. Details
 * collapses to a rail and comes back. The outline does the same where it docks,
 * and between 900px and 1359px, while details is docked, it opens over the
 * canvas and closes again.
 */
export function useColumnControls(): ColumnControls {
  const layout = useEditorLayout();
  const preferences = useAtomValue(columnPreferencesAtom);
  const [outlineOverlayOpen, setOutlineOverlayOpen] = useAtom(
    outlineOverlayOpenAtom
  );
  const setCollapsed = useSetAtom(setColumnCollapsedAtom);
  const shapes = columnShapes({ layout, preferences, outlineOverlayOpen });

  const outlineAction = outlineToggle({
    layout,
    shape: shapes.outline,
    preferences,
  });

  const toggle = (side: ColumnSide) => {
    if (side === "details") {
      setOutlineOverlayOpen(false);
      setCollapsed({ side, collapsed: !preferences.details.collapsed });
      return;
    }
    if (outlineAction === "collapse" || outlineAction === "dock") {
      setCollapsed({ side, collapsed: outlineAction === "collapse" });
      return;
    }
    setOutlineOverlayOpen(outlineAction === "open-overlay");
  };

  const toggleLabel = (side: ColumnSide) => {
    if (side === "details") {
      return shapes.details === "docked" ? "Collapse details" : "Show details";
    }
    return {
      collapse: "Collapse outline",
      dock: "Show outline",
      "open-overlay": "Show outline",
      "close-overlay": "Hide outline",
    }[outlineAction];
  };

  return {
    shapes,
    toggle,
    toggleLabel,
    closeOutlineOverlay: () => setOutlineOverlayOpen(false),
  };
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
