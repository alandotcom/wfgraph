import { describe, expect, it } from "vitest";
import {
  placeTemplateAutocomplete,
  TEMPLATE_AUTOCOMPLETE_GAP,
  TEMPLATE_AUTOCOMPLETE_MAX_HEIGHT,
  TEMPLATE_AUTOCOMPLETE_WIDTH,
} from "./place-template-autocomplete";

const VIEWPORT = { width: 1024, height: 800 };

describe("placeTemplateAutocomplete", () => {
  it("opens below the field when the menu fits under it", () => {
    const anchor = { top: 120, bottom: 156, left: 40 };
    const placement = placeTemplateAutocomplete(anchor, VIEWPORT);

    expect(placement).toEqual({
      side: "bottom",
      top: anchor.bottom + TEMPLATE_AUTOCOMPLETE_GAP,
      left: anchor.left,
      maxHeight: TEMPLATE_AUTOCOMPLETE_MAX_HEIGHT,
    });
  });

  it("opens above the field when there is no room below, growing away from the caret", () => {
    const anchor = { top: 720, bottom: 756, left: 40 };
    const placement = placeTemplateAutocomplete(anchor, VIEWPORT);

    expect(placement.side).toBe("top");
    if (placement.side !== "top") {
      return;
    }

    // CSS `bottom` is the distance from the viewport's bottom edge to the
    // menu's bottom edge. That puts the menu's bottom just above the field,
    // so a 240px list grows upward instead of down through the typed text.
    expect(placement.bottom).toBe(
      VIEWPORT.height - anchor.top + TEMPLATE_AUTOCOMPLETE_GAP
    );
    expect(VIEWPORT.height - placement.bottom).toBeLessThanOrEqual(
      anchor.top - TEMPLATE_AUTOCOMPLETE_GAP
    );
  });

  it("stays below when both sides are tight but the space below is larger", () => {
    const anchor = { top: 40, bottom: 500, left: 40 };
    const placement = placeTemplateAutocomplete(anchor, {
      width: 1024,
      height: 700,
    });

    expect(placement.side).toBe("bottom");
    if (placement.side !== "bottom") {
      return;
    }
    expect(placement.top).toBe(anchor.bottom + TEMPLATE_AUTOCOMPLETE_GAP);
    expect(placement.maxHeight).toBeLessThan(TEMPLATE_AUTOCOMPLETE_MAX_HEIGHT);
  });

  it("caps height to the room on the chosen side so a long list cannot cover the field", () => {
    const anchor = { top: 40, bottom: 76, left: 40 };
    const viewport = { width: 1024, height: 200 };
    const placement = placeTemplateAutocomplete(anchor, viewport);

    expect(placement.side).toBe("bottom");
    expect(placement.maxHeight).toBeLessThan(TEMPLATE_AUTOCOMPLETE_MAX_HEIGHT);
    expect(placement.maxHeight).toBeGreaterThan(0);
    if (placement.side === "bottom") {
      expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(
        viewport.height
      );
    }
  });

  it("shifts left so a w-80 menu stays inside the viewport", () => {
    const anchor = { top: 120, bottom: 156, left: 900 };
    const placement = placeTemplateAutocomplete(anchor, VIEWPORT);

    expect(placement.left + TEMPLATE_AUTOCOMPLETE_WIDTH).toBeLessThanOrEqual(
      VIEWPORT.width
    );
    expect(placement.left).toBeLessThan(anchor.left);
  });

  it("prefers below when the menu fits even if the space above is larger", () => {
    const anchor = { top: 500, bottom: 536, left: 40 };
    const placement = placeTemplateAutocomplete(anchor, VIEWPORT);

    expect(placement.side).toBe("bottom");
  });
});
