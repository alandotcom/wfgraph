import { describe, expect, it } from "vitest";
import {
  type ColumnPreferences,
  columnPreferencesCookie,
  columnShapes,
  detailsToggle,
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
        detailsFloatOpen: true,
      })
    ).toEqual({ outline: "docked", details: "docked" });
    expect(
      columnShapes({
        layout: "wide",
        preferences: preferences(true, true),
        detailsFloatOpen: false,
      })
    ).toEqual({ outline: "rail", details: "rail" });
  });

  it("floats collapsed details at wide widths while it is open", () => {
    expect(
      columnShapes({
        layout: "wide",
        preferences: preferences(false, true),
        detailsFloatOpen: true,
      })
    ).toEqual({ outline: "docked", details: "floating" });
  });

  it("docks the outline at medium widths and floats details while it is open", () => {
    expect(
      columnShapes({
        layout: "medium",
        preferences: preferences(false, false),
        detailsFloatOpen: false,
      })
    ).toEqual({ outline: "docked", details: "rail" });
    expect(
      columnShapes({
        layout: "medium",
        preferences: preferences(true, false),
        detailsFloatOpen: true,
      })
    ).toEqual({ outline: "rail", details: "floating" });
  });
});

describe("detailsToggle", () => {
  it("collapses and docks details at wide widths", () => {
    expect(detailsToggle({ layout: "wide", shape: "docked" })).toBe("collapse");
    expect(detailsToggle({ layout: "wide", shape: "rail" })).toBe("dock");
    expect(detailsToggle({ layout: "wide", shape: "floating" })).toBe("dock");
  });

  it("opens and closes floating details at medium widths", () => {
    expect(detailsToggle({ layout: "medium", shape: "rail" })).toBe("float");
    expect(detailsToggle({ layout: "medium", shape: "floating" })).toBe(
      "close-float"
    );
  });
});
