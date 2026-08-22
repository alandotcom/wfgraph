import { describe, expect, it } from "vitest";
import {
  currentPalettePage,
  openPalette,
  paletteCanGoBack,
  popPalettePage,
  pushPalettePage,
  setPaletteQuery,
  type CommandPaletteState,
} from "#src/lib/command-palette";

/** A palette at the root with something already typed into it. */
function rootWithQuery(query: string): CommandPaletteState {
  return setPaletteQuery(openPalette("workflow_1", { id: "root" }), query);
}

describe("the palette's page stack", () => {
  it("opens at one page, with nothing typed and nowhere to go back to", () => {
    const state = openPalette("workflow_1", { id: "root" });

    expect(currentPalettePage(state)).toEqual({ id: "root" });
    expect(state.query).toBe("");
    expect(paletteCanGoBack(state)).toBe(false);
  });

  it("carries the page it was opened on, so the canvas can skip the root", () => {
    const state = openPalette("workflow_1", {
      id: "add-step",
      at: { x: 40, y: 90 },
    });

    expect(currentPalettePage(state)).toEqual({
      id: "add-step",
      at: { x: 40, y: 90 },
    });
    // Nothing was pushed, so Escape closes rather than returning to a root the
    // user never saw.
    expect(paletteCanGoBack(state)).toBe(false);
  });

  it("goes forward to the next page and offers the way back", () => {
    const state = pushPalettePage(rootWithQuery("tid"), { id: "add-step" });

    expect(currentPalettePage(state)).toEqual({ id: "add-step" });
    expect(paletteCanGoBack(state)).toBe(true);
  });

  // The reason the stack owns the query at all: "tidy" typed at the root
  // matches no node type, so a page arriving with it shows an empty list and
  // no clue why.
  it("clears what was typed on the way forward", () => {
    expect(
      pushPalettePage(rootWithQuery("tidy"), { id: "add-step" }).query
    ).toBe("");
  });

  it("clears what was typed on the way back", () => {
    const onStepPage = setPaletteQuery(
      pushPalettePage(rootWithQuery(""), { id: "add-step" }),
      "slack"
    );

    const back = popPalettePage(onStepPage);

    expect(back?.query).toBe("");
    expect(back && currentPalettePage(back)).toEqual({ id: "root" });
  });

  it("closes rather than emptying the stack when the last page pops", () => {
    expect(
      popPalettePage(openPalette("workflow_1", { id: "root" }))
    ).toBeNull();
  });

  it("keeps the workflow it was opened over across every move", () => {
    const state = pushPalettePage(rootWithQuery("x"), { id: "add-step" });

    expect(state.workflowId).toBe("workflow_1");
    expect(popPalettePage(state)?.workflowId).toBe("workflow_1");
  });
});
