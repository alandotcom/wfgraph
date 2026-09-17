import { describe, expect, it } from "vitest";
import {
  withMobileSheet,
  withMobileSheetScroll,
  withMobileSheetSection,
  withoutTopMobileSheet,
} from "#src/lib/mobile-sheet-navigation";
import {
  EMPTY_SELECTION,
  EMPTY_WORKFLOW_NAVIGATION,
  inspectionInGraph,
  scopeNavigationAt,
  updateScopeNavigation,
  withoutDraftSelections,
  withSelectionOpeningReveal,
  workspaceAddressFromSearch,
} from "#src/lib/workflow-navigation-state";

const graph = {
  nodes: [
    { id: "trigger", data: { type: "lifecycle" } },
    { id: "group_1", data: { type: "group" } },
    { id: "child", parentId: "group_1", data: { type: "action" } },
  ],
  edges: [{ id: "trigger-group_1", target: "group_1" }],
};

describe("mobile Reveal sheets", () => {
  const EMPTY = scopeNavigationAt(
    EMPTY_WORKFLOW_NAVIGATION,
    workspaceAddressFromSearch("workflow_1", {})
  );
  const node = (id: string) => ({ kind: "node" as const, id });
  const nodeSelection = (id: string) => ({ nodeIds: [id], edgeIds: [] });

  it("opens a summary sheet when one object becomes the Draft selection", () => {
    const selected = withSelectionOpeningReveal(EMPTY, nodeSelection("send"));
    expect(selected.mobile.sheets).toEqual([
      {
        level: "summary",
        inspected: node("send"),
        scroll: 0,
        section: null,
      },
    ]);

    const other = withSelectionOpeningReveal(selected, nodeSelection("wait"));
    expect(other.mobile.sheets.map((sheet) => sheet.inspected.id)).toEqual([
      "wait",
    ]);
    expect(
      withSelectionOpeningReveal(other, EMPTY_SELECTION).mobile.sheets
    ).toEqual([]);
  });

  it("opens the inspector over the summary", () => {
    const summary = withSelectionOpeningReveal(EMPTY, nodeSelection("send"));
    const inspector = withMobileSheet(summary, {
      level: "inspector",
      inspected: node("send"),
    });
    expect(inspector.mobile.sheets.map((sheet) => sheet.level)).toEqual([
      "summary",
      "inspector",
    ]);
    expect(
      withMobileSheet(inspector, {
        level: "inspector",
        inspected: node("send"),
      })
    ).toBe(inspector);
  });

  it("puts a summary beneath an inspector opened with no sheet open", () => {
    const inspector = withMobileSheet(EMPTY, {
      level: "inspector",
      inspected: node("lifecycle"),
      section: "cancel-events",
    });
    expect(inspector.selection).toEqual(nodeSelection("lifecycle"));
    expect(
      inspector.mobile.sheets.map((sheet) => [sheet.level, sheet.section])
    ).toEqual([
      ["summary", null],
      ["inspector", "cancel-events"],
    ]);
  });

  it("goes Back one sheet at a time and selects what the sheet beneath shows", () => {
    const split = withSelectionOpeningReveal(EMPTY, nodeSelection("split"));
    const lifecycle = withMobileSheet(split, {
      level: "inspector",
      inspected: node("lifecycle"),
      section: "start-events",
    });
    expect(lifecycle.selection).toEqual(nodeSelection("lifecycle"));

    const back = withoutTopMobileSheet(lifecycle);
    expect(back.selection).toEqual(nodeSelection("split"));
    expect(back.mobile.sheets).toEqual(split.mobile.sheets);

    const closed = withoutTopMobileSheet(back);
    expect(closed.mobile.sheets).toEqual([]);
    expect(closed.selection).toEqual(nodeSelection("split"));
    expect(withoutTopMobileSheet(closed)).toBe(closed);
  });

  it("keeps each sheet's scroll and section, apart from the desktop inspector", () => {
    const summary = withSelectionOpeningReveal(EMPTY, nodeSelection("send"));
    const scrolled = withMobileSheetScroll(summary, {
      depth: 1,
      level: "summary",
      inspected: node("send"),
      top: 240,
    });
    const inspector = withMobileSheet(scrolled, {
      level: "inspector",
      inspected: node("send"),
    });
    const inspectorScrolled = withMobileSheetScroll(inspector, {
      depth: 2,
      level: "inspector",
      inspected: node("send"),
      top: 90,
    });
    expect(
      inspectorScrolled.mobile.sheets.map((sheet) => sheet.scroll)
    ).toEqual([240, 90]);
    expect(inspectorScrolled.desktop.inspectorScroll).toEqual({
      browse: 0,
      focus: 0,
    });

    // A scroll read from a sheet Back has removed lands nowhere.
    const back = withoutTopMobileSheet(inspectorScrolled);
    expect(
      withMobileSheetScroll(back, {
        depth: 2,
        level: "inspector",
        inspected: node("send"),
        top: 12,
      })
    ).toBe(back);
    expect(back.mobile.sheets[0].scroll).toBe(240);

    const sectioned = withMobileSheetSection(
      withMobileSheetScroll(inspector, {
        depth: 2,
        level: "inspector",
        inspected: node("send"),
        top: 30,
      }),
      node("send"),
      "connections"
    );
    expect(sectioned.mobile.sheets[1]).toMatchObject({
      section: "connections",
      scroll: 0,
    });
    expect(withMobileSheetSection(sectioned, node("wait"), "other")).toBe(
      sectioned
    );
  });

  it("closes only the sheets showing an object the graph lost", () => {
    const trigger = withSelectionOpeningReveal(EMPTY, nodeSelection("trigger"));
    const gone = withMobileSheet(trigger, {
      level: "summary",
      inspected: node("gone"),
    });
    const child = withMobileSheet(gone, {
      level: "inspector",
      inspected: node("child"),
    });
    const kept = inspectionInGraph(child, graph);
    expect(kept.mobile.sheets.map((sheet) => sheet.inspected.id)).toEqual([
      "trigger",
      "child",
    ]);
    expect(kept.selection).toEqual(nodeSelection("child"));

    const lost = inspectionInGraph(gone, graph);
    expect(lost.mobile.sheets.map((sheet) => sheet.inspected.id)).toEqual([
      "trigger",
    ]);
    expect(lost.selection).toEqual(nodeSelection("trigger"));
    expect(inspectionInGraph(kept, graph)).toBe(kept);
  });

  it("empties the sheets with the selection when a Draft graph loads", () => {
    const address = workspaceAddressFromSearch("workflow_1", {});
    const navigation = updateScopeNavigation(
      EMPTY_WORKFLOW_NAVIGATION,
      address,
      (scope) => withSelectionOpeningReveal(scope, nodeSelection("trigger"))
    );
    expect(
      scopeNavigationAt(withoutDraftSelections(navigation), address).mobile
        .sheets
    ).toEqual([]);
  });
});
