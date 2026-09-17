/**
 * When the canvas camera moves for Canvas Reveal. The camera moves only to show
 * a subject Reveal would cover, and closing Reveal never moves it.
 */

import type { RevealLevel } from "#src/lib/workflow-navigation-state";

/** What the camera last responded to. */
export type RevealCameraSlot = {
  addressId: string;
  subjectKey: string | null;
  level: RevealLevel;
};

/**
 * A request to place nodes in Canvas Reveal's usable rectangle, for the address
 * it names, as the command palette and an issue link make. `sequence` tells two
 * requests for the same nodes apart.
 */
export type RevealPlacementRequest = {
  addressId: string;
  nodeIds: readonly string[];
  sequence: number;
};

/**
 * What to do when the Reveal the canvas shows changes. A placement request the
 * camera has not answered places its nodes once its address is shown, whichever
 * address was shown before. Otherwise a new address does nothing, because the
 * scope's saved camera restores it. A new subject, opening from Closed, and
 * widening Browse to Focus place the subject. Closing, and narrowing Focus to
 * Browse, keep the camera where it is.
 */
export function revealCameraStep(input: {
  shown: RevealCameraSlot | null;
  next: RevealCameraSlot;
  request: RevealPlacementRequest | null;
  answeredSequence: number;
}): "keep" | "place-request" | "place" {
  const { shown, next, request } = input;
  if (
    request !== null &&
    request.sequence !== input.answeredSequence &&
    request.addressId === next.addressId
  ) {
    return "place-request";
  }
  if (shown === null || shown.addressId !== next.addressId) {
    return "keep";
  }
  if (next.level === "closed") {
    return "keep";
  }
  return shown.subjectKey !== next.subjectKey ||
    shown.level === "closed" ||
    (shown.level === "browse" && next.level === "focus")
    ? "place"
    : "keep";
}
