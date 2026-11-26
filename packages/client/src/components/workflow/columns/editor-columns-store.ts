/**
 * What the editor below the toolbar shows besides the canvas: whether the
 * floating outline is hidden, whether the Inspector card is open, and on a
 * phone whether the map replaces the outline. None of it is kept across
 * reloads or workflows.
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
 * Whether the Inspector card is open over the right of the canvas. Each new
 * subject opens it and losing the subject closes it; its X and Escape with
 * nothing left to unwind close it while the subject stays selected, and
 * pressing a step on the canvas or its outline row opens it again.
 */
export const detailsFloatOpenAtom = atom(false);

/**
 * How many times "Find a step" has asked for the outline's filter field. The
 * outline focuses the field after each request commits, once it has shown the
 * field.
 */
export const outlineFilterFocusRequestAtom = atom(0);
