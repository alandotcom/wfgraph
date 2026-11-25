import { describe, expect, it } from "vitest";
import {
  type ColumnPreferences,
  columnPreferencesCookie,
  columnShapes,
  outlineToggle,
  readColumnPreferences,
} from "./editor-columns-store";

const cookie = (value: unknown) => encodeURIComponent(JSON.stringify(value));

const preferences = (
  outlineCollapsed: boolean,
  detailsCollapsed: boolean
): ColumnPreferences => ({
  outline: { width: undefined, collapsed: outlineCollapsed },
  details: { width: undefined, collapsed: detailsCollapsed },
});

describe("readColumnPreferences", () => {
  it("round-trips the value the preferences write", () => {
    const written: ColumnPreferences = {
      outline: { width: 300, collapsed: true },
      details: { width: 500, collapsed: false },
    };
    expect(readColumnPreferences(columnPreferencesCookie(written))).toEqual(
      written
    );
  });

  it.each([
    { name: "no cookie", value: undefined },
    { name: "text that is not JSON", value: "wide" },
    { name: "a malformed escape", value: "%E0%A4%A" },
    { name: "a JSON array", value: cookie([300, 400]) },
  ])("reads $name as the defaults", ({ value }) => {
    expect(readColumnPreferences(value)).toEqual(preferences(false, false));
  });

  it("drops a width outside the column's range and keeps the rest", () => {
    expect(
      readColumnPreferences(
        cookie({
          outline: { width: 100, collapsed: true },
          details: { width: 400.5, collapsed: "yes" },
        })
      )
    ).toEqual({
      outline: { width: undefined, collapsed: true },
      details: { width: undefined, collapsed: false },
    });
  });
});

describe("columnShapes", () => {
  it("docks both columns at wide widths unless the person collapsed one", () => {
    expect(
      columnShapes({
        layout: "wide",
        preferences: preferences(false, false),
        outlineOverlayOpen: false,
      })
    ).toEqual({ outline: "docked", details: "docked" });
    expect(
      columnShapes({
        layout: "wide",
        preferences: preferences(true, false),
        outlineOverlayOpen: false,
      })
    ).toEqual({ outline: "rail", details: "docked" });
  });

  it("keeps the outline a rail at medium widths while details is docked", () => {
    expect(
      columnShapes({
        layout: "medium",
        preferences: preferences(false, false),
        outlineOverlayOpen: false,
      })
    ).toEqual({ outline: "rail", details: "docked" });
    expect(
      columnShapes({
        layout: "medium",
        preferences: preferences(false, false),
        outlineOverlayOpen: true,
      })
    ).toEqual({ outline: "overlay", details: "docked" });
  });

  it("docks the outline at medium widths once details is collapsed", () => {
    expect(
      columnShapes({
        layout: "medium",
        preferences: preferences(false, true),
        outlineOverlayOpen: false,
      })
    ).toEqual({ outline: "docked", details: "rail" });
  });
});

describe("outlineToggle", () => {
  it("collapses a docked outline and docks a collapsed one where it fits", () => {
    expect(
      outlineToggle({
        layout: "wide",
        shape: "docked",
        preferences: preferences(false, false),
      })
    ).toBe("collapse");
    expect(
      outlineToggle({
        layout: "wide",
        shape: "rail",
        preferences: preferences(true, false),
      })
    ).toBe("dock");
    expect(
      outlineToggle({
        layout: "medium",
        shape: "rail",
        preferences: preferences(true, true),
      })
    ).toBe("dock");
  });

  it("opens and closes the outline over the canvas at medium widths", () => {
    expect(
      outlineToggle({
        layout: "medium",
        shape: "rail",
        preferences: preferences(false, false),
      })
    ).toBe("open-overlay");
    expect(
      outlineToggle({
        layout: "medium",
        shape: "overlay",
        preferences: preferences(false, false),
      })
    ).toBe("close-overlay");
  });
});
