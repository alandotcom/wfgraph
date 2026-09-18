/**
 * Whether the command palette is up, and what it is showing.
 *
 * Its own module rather than a corner of `workflow-ui-store`: the open rule
 * reads the graph store and the save store, and `workflow-graph-store` already
 * imports the UI store, so an atom over there would close that circle.
 */

import { atom } from "jotai";
import {
  openPalette,
  type CommandPalettePage,
  type CommandPaletteState,
} from "#src/lib/command-palette";
import { canvasEditingLockedAtom } from "#src/lib/workflow-graph-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";

const paletteCellAtom = atom<CommandPaletteState | null>(null);

/**
 * Why the palette will not open, written for the person who asked, or null when
 * it will.
 *
 * Root search remains available in read-only workspaces. Add step stays behind
 * the canvas editing lock, which is the same gate the Actions menu uses.
 */
export const commandPaletteRefusalAtom = atom((get) => {
  return get(currentWorkflowIdAtom)
    ? null
    : "Save the workflow before opening the command palette.";
});

/**
 * The palette as it is on screen, or null while it is closed.
 *
 * The read discards a palette belonging to another workflow rather than
 * carrying it over: a page stack holds a canvas position, and the position the
 * user pointed at in one workflow means nothing on the next one's graph.
 */
export const commandPaletteAtom = atom(
  (get) => {
    const state = get(paletteCellAtom);
    if (!state) {
      return null;
    }
    return state.workflowId === get(currentWorkflowIdAtom) ? state : null;
  },
  (_get, set, next: CommandPaletteState | null) => {
    set(paletteCellAtom, next);
  }
);

/**
 * Open the palette on `page`. Answers false when it refused, so the caller can
 * say why rather than swallowing the keystroke.
 *
 * A workflow with no id yet gets no palette. Every canvas the editor can show
 * has one by the time it is drawn, and keying the held state to an id that is
 * about to change would make a first save look like a navigation to somewhere
 * else.
 */
export const openCommandPaletteAtom = atom(
  null,
  (get, set, page: CommandPalettePage): boolean => {
    const workflowId = get(currentWorkflowIdAtom);
    if (!workflowId) {
      return false;
    }
    if (page.id === "add-step" && get(canvasEditingLockedAtom)) {
      return false;
    }
    set(paletteCellAtom, openPalette(workflowId, page));
    return true;
  }
);
