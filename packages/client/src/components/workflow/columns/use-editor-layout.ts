import { useSyncExternalStore } from "react";
import { useIsMobile } from "#src/hooks/use-mobile";
import type { EditorLayout } from "./editor-columns-store";

/**
 * The narrowest window that docks both side columns: 85rem, 1360px at the
 * default font size. Below `md` (900px) the editor shows its phone layout.
 */
const WIDE_LAYOUT_QUERY = "(min-width: 85rem)";

let wideQuery: MediaQueryList | undefined;

/** One `MediaQueryList` for the whole app, as `useIsMobile` keeps. */
function getWideQuery(): MediaQueryList {
  wideQuery ??= window.matchMedia(WIDE_LAYOUT_QUERY);
  return wideQuery;
}

function subscribe(onViewportChange: () => void) {
  const query = getWideQuery();
  query.addEventListener("change", onViewportChange);
  return () => query.removeEventListener("change", onViewportChange);
}

function isWideViewport(): boolean {
  return getWideQuery().matches;
}

/**
 * Which of the editor's three window widths the viewport is at now. It reads
 * the window rather than the editor shell, so the shell's inset does not move
 * a boundary.
 */
export function useEditorLayout(): EditorLayout {
  const isWide = useSyncExternalStore(subscribe, isWideViewport);
  const isMobile = useIsMobile();
  if (isMobile) {
    return "compact";
  }
  return isWide ? "wide" : "medium";
}
