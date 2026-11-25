import { describe, expect, it } from "vitest";
import {
  groupRegionBox,
  hasLegacyGroupLayout,
} from "#src/graph/workflow-layout-geometry";

const member = (id: string, y: number) => ({
  id,
  parentId: "g",
  position: { x: 0, y },
  data: { type: "action" },
});

describe("hasLegacyGroupLayout", () => {
  it("matches a frame holding members stored with no size or at the collapsed card's size", () => {
    const members = [member("a", 0), member("b", 180)];
    const frame = { id: "g", data: { type: "group" } };

    expect(hasLegacyGroupLayout([frame, ...members])).toBe(true);
    expect(
      hasLegacyGroupLayout([{ ...frame, width: 192, height: 112 }, ...members])
    ).toBe(true);
  });

  it("never matches a frame stored at a region's size, however its members moved since", () => {
    const members = [member("a", 0), member("b", 180)];
    const frame = {
      id: "g",
      data: { type: "group" },
      ...groupRegionBox(members),
    };

    expect(hasLegacyGroupLayout([frame, ...members])).toBe(false);
    expect(
      hasLegacyGroupLayout([frame, member("a", 0), member("b", 900)])
    ).toBe(false);
  });

  it("ignores a frame with no member and a graph with no Group", () => {
    expect(hasLegacyGroupLayout([{ id: "g", data: { type: "group" } }])).toBe(
      false
    );
    expect(hasLegacyGroupLayout([member("a", 0)])).toBe(false);
  });
});
