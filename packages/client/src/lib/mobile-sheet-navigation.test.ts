import { describe, expect, it } from "vitest";
import {
  withMobileAddressSheet,
  withMobileFullSheetOverAddress,
  withMobileSequenceFrom,
  withMobileSheet,
  withMobileSheetScroll,
  withoutTopMobileSheet,
} from "#src/lib/mobile-sheet-navigation";
import {
  EMPTY_SELECTION,
  EMPTY_WORKFLOW_NAVIGATION,
  inspectionInGraph,
  workspaceNavigationAt,
  updateWorkspaceNavigation,
  withoutDraftSelections,
  withInspectedSelection,
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
  const EMPTY = workspaceNavigationAt(
    EMPTY_WORKFLOW_NAVIGATION,
    workspaceAddressFromSearch("workflow_1", {})
  );
  const node = (id: string) => ({ kind: "node" as const, id });
  const nodeSelection = (id: string) => ({ nodeIds: [id], edgeIds: [] });

  it("opens a summary sheet when one object becomes the Draft selection", () => {
    const selected = withInspectedSelection(EMPTY, nodeSelection("send"));
    expect(selected.mobile.sheets).toEqual([
      { level: "summary", inspected: node("send"), scroll: 0 },
    ]);

    const other = withInspectedSelection(selected, nodeSelection("wait"));
    expect(other.mobile.sheets.map((sheet) => sheet.inspected?.id)).toEqual([
      "wait",
    ]);
    expect(
      withInspectedSelection(other, EMPTY_SELECTION).mobile.sheets
    ).toEqual([]);
  });

  it("opens the full sheet over the summary", () => {
    const summary = withInspectedSelection(EMPTY, nodeSelection("send"));
    const inspector = withMobileSheet(summary, {
      level: "full",
      inspected: node("send"),
    });
    expect(inspector.mobile.sheets.map((sheet) => sheet.level)).toEqual([
      "summary",
      "full",
    ]);
    expect(
      withMobileSheet(inspector, {
        level: "full",
        inspected: node("send"),
      })
    ).toBe(inspector);
  });

  it("puts a summary beneath an inspector opened with no sheet open", () => {
    const inspector = withMobileSheet(EMPTY, {
      level: "full",
      inspected: node("lifecycle"),
    });
    expect(inspector.selection).toEqual(nodeSelection("lifecycle"));
    expect(inspector.mobile.sheets.map((sheet) => sheet.level)).toEqual([
      "summary",
      "full",
    ]);
  });

  it("goes Back one sheet at a time and selects what the sheet beneath shows", () => {
    const split = withInspectedSelection(EMPTY, nodeSelection("split"));
    const lifecycle = withMobileSheet(split, {
      level: "full",
      inspected: node("lifecycle"),
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

  it("keeps each sheet's scroll, apart from the desktop inspector", () => {
    const summary = withInspectedSelection(EMPTY, nodeSelection("send"));
    const scrolled = withMobileSheetScroll(summary, {
      depth: 1,
      level: "summary",
      inspected: node("send"),
      top: 240,
    });
    const inspector = withMobileSheet(scrolled, {
      level: "full",
      inspected: node("send"),
    });
    const inspectorScrolled = withMobileSheetScroll(inspector, {
      depth: 2,
      level: "full",
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
        level: "full",
        inspected: node("send"),
        top: 12,
      })
    ).toBe(back);
    expect(back.mobile.sheets[0].scroll).toBe(240);
  });

  it("closes only the sheets showing an object the graph lost", () => {
    const trigger = withInspectedSelection(EMPTY, nodeSelection("trigger"));
    const gone = withMobileSheet(trigger, {
      level: "summary",
      inspected: node("gone"),
    });
    const child = withMobileSheet(gone, {
      level: "full",
      inspected: node("child"),
    });
    const kept = inspectionInGraph(child, graph);
    expect(kept.mobile.sheets.map((sheet) => sheet.inspected?.id)).toEqual([
      "trigger",
      "child",
    ]);
    expect(kept.selection).toEqual(nodeSelection("child"));

    const lost = inspectionInGraph(gone, graph);
    expect(lost.mobile.sheets.map((sheet) => sheet.inspected?.id)).toEqual([
      "trigger",
    ]);
    expect(lost.selection).toEqual(nodeSelection("trigger"));
    expect(inspectionInGraph(kept, graph)).toBe(kept);
  });

  it("empties the sheets with the selection when a Draft graph loads", () => {
    const address = workspaceAddressFromSearch("workflow_1", {});
    const navigation = updateWorkspaceNavigation(
      EMPTY_WORKFLOW_NAVIGATION,
      address,
      (scope) => withInspectedSelection(scope, nodeSelection("trigger"))
    );
    expect(
      workspaceNavigationAt(withoutDraftSelections(navigation), address).mobile
        .sheets
    ).toEqual([]);
  });

  it("opens an address sheet once, and shows evidence over it without changing the selection", () => {
    const address = withMobileAddressSheet(EMPTY);
    expect(address.mobile.sheets).toEqual([
      { level: "summary", inspected: null, scroll: 0 },
    ]);
    expect(withMobileAddressSheet(address)).toBe(address);

    const scrolled = withMobileSheetScroll(address, {
      depth: 1,
      level: "summary",
      inspected: null,
      top: 70,
    });
    const evidence = withMobileFullSheetOverAddress(scrolled, node("send"));
    expect(evidence.selection).toBe(scrolled.selection);
    expect(
      evidence.mobile.sheets.map((sheet) => [
        sheet.level,
        sheet.inspected?.id ?? null,
        sheet.scroll,
      ])
    ).toEqual([
      ["summary", null, 70],
      ["full", "send", 0],
    ]);
    expect(withMobileFullSheetOverAddress(evidence, node("send"))).toBe(
      evidence
    );

    const other = withMobileFullSheetOverAddress(evidence, node("wait"));
    expect(other.mobile.sheets.map((sheet) => sheet.inspected?.id)).toEqual([
      undefined,
      "wait",
    ]);

    const fromNothing = withMobileFullSheetOverAddress(EMPTY, node("send"));
    expect(
      fromNothing.mobile.sheets.map((sheet) => sheet.inspected?.id ?? null)
    ).toEqual([null, "send"]);
  });

  it("keeps the selection on Back to an address sheet and keeps address sheets in any graph", () => {
    const selected = {
      ...withMobileFullSheetOverAddress(
        withMobileAddressSheet(EMPTY),
        node("gone")
      ),
      selection: nodeSelection("gone"),
    };
    const back = withoutTopMobileSheet(selected);
    expect(back.selection).toEqual(nodeSelection("gone"));
    expect(back.mobile.sheets.map((sheet) => sheet.inspected)).toEqual([null]);

    const recovered = inspectionInGraph(selected, graph);
    expect(recovered.mobile.sheets.map((sheet) => sheet.inspected)).toEqual([
      null,
    ]);
    expect(recovered.selection).toBe(selected.selection);
  });

  it("opens one address sheet at an address reached from one with a sheet open", () => {
    const source = [{ level: "summary" as const, inspected: null, scroll: 30 }];
    expect(withMobileSequenceFrom(EMPTY, source).mobile.sheets).toEqual([
      { level: "summary", inspected: null, scroll: 0 },
    ]);

    const open = withMobileAddressSheet(EMPTY);
    expect(withMobileSequenceFrom(open, source)).toBe(open);
    expect(withMobileSequenceFrom(EMPTY, [])).toBe(EMPTY);
  });

  it("pushes a full sheet over an address sheet that is not one", () => {
    const listed = {
      ...EMPTY,
      mobile: {
        ...EMPTY.mobile,
        sheets: [
          { level: "summary" as const, inspected: null, scroll: 0 },
          { level: "summary" as const, inspected: null, scroll: 12 },
        ],
      },
    };
    const pushed = withMobileFullSheetOverAddress(listed, node("send"));
    expect(
      pushed.mobile.sheets.map((sheet) => [
        sheet.level,
        sheet.scroll,
        sheet.inspected?.id ?? null,
      ])
    ).toEqual([
      ["summary", 0, null],
      ["summary", 12, null],
      ["full", 0, "send"],
    ]);
  });
});
