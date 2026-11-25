import { useSyncExternalStore } from "react";
import type { EditorLayout } from "./editor-columns-store";

/** The narrowest window that docks both side columns. */
export const WIDE_LAYOUT_MIN_PX = 1360;

/** The narrowest window that shows the canvas beside a side column. */
export const MEDIUM_LAYOUT_MIN_PX = 900;

let queries: { wide: MediaQueryList; medium: MediaQueryList } | undefined;

/** One pair of `MediaQueryList`s for the whole app, as `useIsMobile` keeps. */
function layoutQueries() {
  queries ??= {
    wide: window.matchMedia(`(min-width: ${WIDE_LAYOUT_MIN_PX}px)`),
    medium: window.matchMedia(`(min-width: ${MEDIUM_LAYOUT_MIN_PX}px)`),
  };
  return queries;
}

function subscribe(onViewportChange: () => void) {
  const { wide, medium } = layoutQueries();
  wide.addEventListener("change", onViewportChange);
  medium.addEventListener("change", onViewportChange);
  return () => {
    wide.removeEventListener("change", onViewportChange);
    medium.removeEventListener("change", onViewportChange);
  };
}

function currentLayout(): EditorLayout {
  const { wide, medium } = layoutQueries();
  if (wide.matches) {
    return "wide";
  }
  return medium.matches ? "medium" : "compact";
}

/**
 * Which of the editor's three window widths the viewport is at now. It reads
 * the window rather than the editor shell, so the shell's inset does not move
 * a boundary.
 */
export function useEditorLayout(): EditorLayout {
  return useSyncExternalStore(subscribe, currentLayout);
}
