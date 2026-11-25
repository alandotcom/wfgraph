import { describe, expect, it } from "vitest";
import { paletteMatchRank, rankPaletteGroups } from "#src/lib/palette-search";

const row = (label: string, keywords = label) => ({ label, keywords });

describe("paletteMatchRank", () => {
  it("ranks the label the query names ahead of every weaker match", () => {
    expect(paletteMatchRank(row("Publish workflow"), "publish workflow")).toBe(
      0
    );
    expect(paletteMatchRank(row("Publish workflow"), "pub")).toBe(1);
    expect(paletteMatchRank(row("Go to version history"), "version")).toBe(2);
    expect(paletteMatchRank(row("Save workflow"), "flow")).toBe(3);
    expect(
      paletteMatchRank(
        row("Go to version history", "version history published"),
        "publish"
      )
    ).toBe(4);
    expect(paletteMatchRank(row("Save workflow"), "delay")).toBeNull();
  });

  it("ignores case and accents", () => {
    expect(paletteMatchRank(row("Résumé step"), "RESUME")).toBe(1);
  });
});

describe("paletteMatchRank for a step number", () => {
  const step = {
    label: "Wait 13 days",
    keywords: "Wait 13 days",
    stepNumber: 7,
  };

  it("matches a query of digits only against the step's number", () => {
    expect(paletteMatchRank(step, "13")).toBeNull();
    expect(paletteMatchRank(step, "7")).toBe(0);
    expect(paletteMatchRank(step, "wait")).toBe(1);
  });
});

describe("rankPaletteGroups", () => {
  it("puts the row a query names first, then the group holding it", () => {
    const groups = [
      {
        id: "workflow",
        items: [
          row("Go to version history", "version history published"),
          row("Publish workflow"),
        ],
      },
      {
        id: "nodes",
        items: [
          row("Send booking confirmation", "Send Patient Message"),
          row("Send Patient Message"),
        ],
      },
    ];

    expect(
      rankPaletteGroups(groups, "publish").map((group) =>
        group.items.map((item) => item.label)
      )
    ).toEqual([["Publish workflow", "Go to version history"]]);

    expect(
      rankPaletteGroups(groups, "send patient message").map(
        (group) => group.items[0]?.label
      )
    ).toEqual(["Send Patient Message"]);
  });

  it("keeps the authored order between rows and groups of equal rank", () => {
    const groups = [
      { id: "a", items: [row("Wait one"), row("Wait two")] },
      { id: "b", items: [row("Wait three")] },
    ];

    expect(
      rankPaletteGroups(groups, "wait").flatMap((group) =>
        group.items.map((item) => item.label)
      )
    ).toEqual(["Wait one", "Wait two", "Wait three"]);
  });
});
