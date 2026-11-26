import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useDomEvent } from "#src/hooks/effects";
import { useIsMobile } from "#src/hooks/use-mobile";
import { editorChordAllowed } from "#src/lib/editor-shortcuts";
import { OUTLINE_SHORTCUT_KEY } from "#src/lib/shortcut-label";
import { showsRunList } from "#src/lib/workflow-navigation-state";
import { activeWorkspaceAddressAtom } from "#src/lib/workflow-workspace-navigation";
import {
  outlineFilterFocusRequestAtom,
  outlineHiddenAtom,
  phoneShowsMapAtom,
} from "./editor-layout-store";

export type OutlineControls = {
  /** Whether the outline is on screen: floating over the canvas, or a phone's main view. */
  shown: boolean;
  /**
   * Whether `[` and the palette command can hide the outline now. The run
   * list cannot be hidden, because it is the only way to open a run, and a
   * phone shows the outline or the map through its Map control instead.
   */
  canHide: boolean;
  /**
   * Whether "Find a step" and Cmd+F have steps to filter: everywhere but the
   * run list.
   */
  canFind: boolean;
  /** What the shortcut and the palette command do now, in words. */
  toggleLabel: string;
  /** Hide the outline, or show it again. */
  toggle: () => void;
  /**
   * Bring the outline into view, showing it over the canvas or leaving a
   * phone's map, and put the cursor in its "Filter steps" field. The run list
   * has no steps to filter, so there it does nothing, and no request is left
   * waiting for the next outline that mounts.
   */
  findStep: () => void;
};

/**
 * Whether the floating outline shows, and the one action `[`, its palette
 * command and "Find a step" share. In Runs with no run open the outline is
 * the run list, which always shows.
 */
export function useOutlineControls(): OutlineControls {
  const isMobile = useIsMobile();
  const [hidden, setHidden] = useAtom(outlineHiddenAtom);
  const [phoneShowsMap, setPhoneShowsMap] = useAtom(phoneShowsMapAtom);
  const requestFilterFocus = useSetAtom(outlineFilterFocusRequestAtom);
  const { key } = useAtomValue(activeWorkspaceAddressAtom);
  const runList = showsRunList(key);
  const canHide = !isMobile && !runList;
  const shown = isMobile ? !phoneShowsMap : !(canHide && hidden);

  return {
    shown,
    canHide,
    canFind: !runList,
    toggleLabel: shown ? "Hide outline" : "Show outline",
    toggle: () => {
      if (canHide) {
        setHidden(shown);
      }
    },
    findStep: () => {
      if (runList) {
        return;
      }
      if (isMobile) {
        setPhoneShowsMap(false);
      } else {
        setHidden(false);
      }
      requestFilterFocus(true);
    },
  };
}

/**
 * Cmd+F or Ctrl+F brings the outline into view and puts the cursor in its
 * filter field. On the run list, which has no steps to filter, the chord is
 * left to the browser.
 */
export function useFindStepShortcut(controls: OutlineControls): void {
  useDomEvent(
    document,
    "keydown",
    (event) => {
      if (
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
    },
    { enabled: controls.canFind }
  );
}

/**
 * `[` hides and shows the floating outline from anywhere in the editor but a
 * text field, an open dialog or menu, or with a modifier held.
 */
export function useOutlineShortcut(controls: OutlineControls): void {
  useDomEvent(
    document,
    "keydown",
    (event) => {
      if (
        event.key !== OUTLINE_SHORTCUT_KEY ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.defaultPrevented ||
        !editorChordAllowed(event, { inTextFields: false })
      ) {
        return;
      }
      event.preventDefault();
      controls.toggle();
    },
    { enabled: controls.canHide }
  );
}
