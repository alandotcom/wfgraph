/**
 * When the canvas camera moves to show nodes: once per placement request on
 * desktop, and for the mobile Reveal sheets. Removing a sheet never moves it.
 */

import type { MobileRevealLevel } from "#src/lib/mobile-sheet-navigation";
import type { InspectedObject } from "#src/lib/workflow-navigation-state";
import { sameObject } from "#src/lib/canvas-selection";

/**
 * A request to show nodes in the canvas's usable rectangle, for the address it
 * names, as the command palette and an issue link make. `sequence` tells two
 * requests for the same nodes apart.
 */
export type RevealPlacementRequest = {
  addressId: string;
  nodeIds: readonly string[];
  sequence: number;
};

/**
 * What the mobile camera last responded to: an address and the sheet on top of
 * its mobile Reveal sequence, with `depth` 1 for the first sheet. `sheet` is
 * null while no sheet shows.
 */
export type MobileSheetCameraSlot = {
  addressId: string;
  sheet: {
    depth: number;
    level: MobileRevealLevel;
    inspected: InspectedObject | null;
  } | null;
};

/**
 * Whether the mobile camera places the subject of the sheet that shows. A
 * summary sheet that opens in the address already shown places its subject
 * above the sheet: the first sheet, a sheet opened over another, or a sheet
 * showing another object at the same depth. Back, which removes a sheet, keeps
 * the camera where it is. A new address keeps the camera its scope restored.
 */
export function mobileSheetCameraStep(input: {
  shown: MobileSheetCameraSlot | null;
  next: MobileSheetCameraSlot;
}): "keep" | "place" {
  const { shown, next } = input;
  if (
    shown === null ||
    shown.addressId !== next.addressId ||
    next.sheet === null ||
    next.sheet.level !== "summary"
  ) {
    return "keep";
  }
  if (shown.sheet === null || next.sheet.depth > shown.sheet.depth) {
    return "place";
  }
  return next.sheet.depth === shown.sheet.depth &&
    !sameObject(next.sheet.inspected, shown.sheet.inspected)
    ? "place"
    : "keep";
}
