/**
 * Requests other surfaces make of Canvas Reveal: place nodes in the usable
 * rectangle, place the subject again after a resize, focus an element of a
 * node's Focus body, and focus Reveal's title. The canvas camera answers each
 * placement once; the Reveal shell clears a field or title request once it has
 * moved focus.
 */

import { atom } from "jotai";
import type { RevealPlacementRequest } from "./reveal-camera";

export const revealPlacementRequestAtom = atom<RevealPlacementRequest | null>(
  null
);

/** Ask the canvas camera to place `nodeIds` once `addressId` is shown. */
export const requestRevealPlacementAtom = atom(
  null,
  (get, set, input: { addressId: string; nodeIds: readonly string[] }) => {
    set(revealPlacementRequestAtom, {
      ...input,
      sequence: (get(revealPlacementRequestAtom)?.sequence ?? 0) + 1,
    });
  }
);

/**
 * How many times a person has finished resizing Canvas Reveal. The desktop
 * camera places the subject once each time the count changes, and a width that
 * changes during a drag moves no camera.
 */
export const revealResizeSequenceAtom = atom(0);

/**
 * True from the first key press of a keyboard resize until that resize
 * finishes. The desktop camera records the camera it holds when this turns
 * true, and places the subject from that camera when the resize finishes.
 */
export const revealKeyResizeInProgressAtom = atom(false);

/**
 * An element Canvas Reveal focuses once the node `nodeId` names is shown at
 * Focus. `targetId` is the element id: a field's config key, which is also its
 * control's id, or a section heading's id.
 */
export type RevealFieldRequest = { nodeId: string; targetId: string };

export const revealFieldRequestAtom = atom<RevealFieldRequest | null>(null);

/**
 * A node whose Canvas Reveal title takes focus once Reveal shows that node. A
 * surface that selects a step and then closes, such as the command palette,
 * asks for this, because the control that had focus is gone.
 */
export const revealTitleFocusRequestAtom = atom<string | null>(null);
