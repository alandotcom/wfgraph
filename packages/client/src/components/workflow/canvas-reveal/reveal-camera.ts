/**
 * When the canvas camera moves for Canvas Reveal, and which camera a placement
 * starts from. Cameras are world cameras, so they compare across renders
 * regardless of the canvas size.
 */

import type {
  RevealCamera,
  RevealLevel,
  WorldCamera,
} from "#src/lib/workflow-navigation-state";
import { sameWorldCamera } from "#src/components/workflow/workflow-viewport";

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
 * scope's saved camera restores it; a new subject or open level places the
 * subject; and closing restores the camera Reveal started from.
 */
export function revealCameraStep(input: {
  shown: RevealCameraSlot | null;
  next: RevealCameraSlot;
  request: RevealPlacementRequest | null;
  answeredSequence: number;
}): "keep" | "place-request" | "place" | "restore" {
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
    return shown.level === "closed" ? "keep" : "restore";
  }
  return shown.level !== next.level || shown.subjectKey !== next.subjectKey
    ? "place"
    : "keep";
}

/**
 * The camera from before Reveal's last placement, while the viewport still sits
 * where that placement put it, and null once a person has moved the camera. A
 * placement starts from this camera when there is one, so each Browse and Focus
 * change recomputes against one anchor, and closing returns to it.
 */
export function untouchedBefore(
  current: WorldCamera,
  stored: RevealCamera | null
): WorldCamera | null {
  return stored && sameWorldCamera(current, stored.placed)
    ? stored.before
    : null;
}
