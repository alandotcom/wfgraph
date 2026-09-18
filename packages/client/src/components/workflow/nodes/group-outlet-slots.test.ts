import { describe, expect, it } from "vitest";
import { groupOutletSlots } from "#src/components/workflow/nodes/group-outlet-slots";

/** The width a collapsed Group card draws at, in pixels. */
const CARD_WIDTH = 192;

/**
 * Each label's widest horizontal extent on a card `CARD_WIDTH` wide, in
 * pixels, read back from the CSS the slots produce.
 */
function labelExtents(count: number) {
  return groupOutletSlots(count).map((slot) => {
    const centre = (Number.parseFloat(slot.offset) / 100) * CARD_WIDTH;
    const match = /^calc\(([\d.]+)% - ([\d.]+)px\)$/.exec(slot.labelMaxWidth);
    if (!match) {
      throw new Error(`Unexpected label width ${slot.labelMaxWidth}`);
    }
    const width =
      (Number.parseFloat(match[1]) / 100) * CARD_WIDTH -
      Number.parseFloat(match[2]);
    return { left: centre - width / 2, right: centre + width / 2 };
  });
}

describe("groupOutletSlots", () => {
  it("centres a lone outlet", () => {
    expect(groupOutletSlots(1)).toEqual([
      { offset: "50%", labelMaxWidth: "calc(100% - 4px)" },
    ]);
  });

  it.each([2, 3])(
    "keeps %i path-end labels inside the card and clear of each other",
    (count) => {
      const extents = labelExtents(count);

      expect(extents).toHaveLength(count);
      for (const [index, extent] of extents.entries()) {
        expect(extent.left).toBeGreaterThanOrEqual(0);
        expect(extent.right).toBeLessThanOrEqual(CARD_WIDTH);
        const next = extents[index + 1];
        if (next) {
          expect(next.left - extent.right).toBeGreaterThanOrEqual(4);
        }
      }
    }
  );
});
