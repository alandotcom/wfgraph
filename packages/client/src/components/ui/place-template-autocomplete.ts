/**
 * Places the template autocomplete against a field's viewport rect.
 *
 * Coordinates are for `position: fixed` (no scroll offset). The menu opens
 * below the field, or above when that would overflow, and never overlaps it.
 */

/** Matches the menu's `w-80`. */
export const TEMPLATE_AUTOCOMPLETE_WIDTH = 320;

/** Cap on the scrolling option list. */
export const TEMPLATE_AUTOCOMPLETE_MAX_HEIGHT = 240;

/** Gap between the field chrome and the menu. */
export const TEMPLATE_AUTOCOMPLETE_GAP = 4;

const VIEWPORT_PADDING = 8;

export type TemplateAutocompleteAnchor = {
  top: number;
  bottom: number;
  left: number;
};

type TemplateAutocompletePlacement =
  | {
      side: "bottom";
      top: number;
      left: number;
      maxHeight: number;
    }
  | {
      side: "top";
      bottom: number;
      left: number;
      maxHeight: number;
    };

/**
 * Choose a side and a box that stays off the field and inside the viewport.
 *
 * Opening below is the default. The menu only flips above when its max height
 * would not fit under the field and the space above is larger. Using CSS
 * `bottom` on that flip is what keeps a tall menu growing away from the caret
 * instead of down through it.
 */
export function placeTemplateAutocomplete(
  anchor: TemplateAutocompleteAnchor,
  viewport: { width: number; height: number }
): TemplateAutocompletePlacement {
  const spaceBelow =
    viewport.height - anchor.bottom - TEMPLATE_AUTOCOMPLETE_GAP - VIEWPORT_PADDING;
  const spaceAbove = anchor.top - TEMPLATE_AUTOCOMPLETE_GAP - VIEWPORT_PADDING;
  const openBelow =
    spaceBelow >= TEMPLATE_AUTOCOMPLETE_MAX_HEIGHT || spaceBelow >= spaceAbove;

  const left = clamp(
    anchor.left,
    VIEWPORT_PADDING,
    Math.max(
      VIEWPORT_PADDING,
      viewport.width - TEMPLATE_AUTOCOMPLETE_WIDTH - VIEWPORT_PADDING
    )
  );

  if (openBelow) {
    return {
      side: "bottom",
      top: anchor.bottom + TEMPLATE_AUTOCOMPLETE_GAP,
      left,
      maxHeight: fittedHeight(spaceBelow),
    };
  }

  return {
    side: "top",
    bottom: viewport.height - anchor.top + TEMPLATE_AUTOCOMPLETE_GAP,
    left,
    maxHeight: fittedHeight(spaceAbove),
  };
}

function fittedHeight(available: number): number {
  return Math.max(0, Math.min(TEMPLATE_AUTOCOMPLETE_MAX_HEIGHT, available));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
