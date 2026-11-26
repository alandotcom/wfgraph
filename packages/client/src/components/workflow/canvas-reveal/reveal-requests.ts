/**
 * Requests other surfaces make of the canvas camera and the Inspector:
 * show nodes in the usable rectangle, focus an element of a node's form, and
 * focus the Inspector's title. The canvas camera answers each placement once;
 * `InspectorContents` clears a field or title request once it has moved focus.
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
 * An element the Inspector focuses once it shows the node `nodeId` names, or
 * once a phone shows that node's full-screen editor. `targetId` is the element
 * id: a field's config key, which is also its control's id, or a section
 * heading's id.
 */
export type RevealFieldRequest = { nodeId: string; targetId: string };

export const revealFieldRequestAtom = atom<RevealFieldRequest | null>(null);

/**
 * A node whose details title takes focus once the Inspector shows that node. A
 * surface that selects a step and then closes, such as the command palette,
 * asks for this, because the control that had focus is gone.
 */
export const revealTitleFocusRequestAtom = atom<string | null>(null);

/**
 * Focus the element `targetId` names in the inspector of `nodeId` once it
 * shows, or its details title when `targetId` is null, as the edit targets in
 * `reveal-edit-target.ts` answer.
 */
export const requestRevealEditFocusAtom = atom(
  null,
  (_get, set, input: { nodeId: string; targetId: string | null }) => {
    if (input.targetId === null) {
      set(revealTitleFocusRequestAtom, input.nodeId);
      return;
    }
    set(revealFieldRequestAtom, {
      nodeId: input.nodeId,
      targetId: input.targetId,
    });
  }
);
