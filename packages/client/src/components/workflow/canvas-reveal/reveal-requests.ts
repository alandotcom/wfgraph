/**
 * Requests other surfaces make of Canvas Reveal: place nodes in the usable
 * rectangle, and focus a field of a step's Focus form. The canvas camera
 * answers each placement once; the Reveal shell clears a field request once it
 * has focused the field.
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
 * A field Canvas Reveal focuses once the step `nodeId` names is shown at Focus.
 * `fieldKey` is the config key, which is also the field control's element id.
 */
export type RevealFieldRequest = { nodeId: string; fieldKey: string };

export const revealFieldRequestAtom = atom<RevealFieldRequest | null>(null);
