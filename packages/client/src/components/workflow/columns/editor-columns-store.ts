/**
 * What the editor below the toolbar shows besides the canvas: whether the
 * floating outline is hidden, and on a phone whether the map replaces the
 * outline. None of it is kept across reloads or workflows. Whether the
 * Inspector card is open derives from its subject, in `canvas-reveal-state.ts`.
 */

import { atom } from "jotai";

/**
 * Whether a phone shows the canvas, which the toolbar's Map control chooses,
 * in place of the outline.
 */
export const phoneShowsMapAtom = atom(false);

/**
 * Whether the person hid the outline floating over the canvas with `[` or its
 * palette command. "Find a step" shows it again. The run list ignores it,
 * because the list is the only way to open a run.
 */
export const outlineHiddenAtom = atom(false);

/**
 * Whether Cmd+F or "Find a step" has asked for the outline's filter field and
 * the outline has not answered yet. The outline shows the field, puts the
 * cursor in it, and clears the request.
 */
export const outlineFilterFocusRequestAtom = atom(false);
