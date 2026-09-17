import { describe, expect, it } from "vitest";
import {
  EMPTY_SELECTION,
  EMPTY_WORKFLOW_NAVIGATION,
  RETAINED_KEYS_PER_VIEW,
  cameraStep,
  graphStructureKey,
  groupScopeExists,
  inspectionInGraph,
  recoveredRouteSearch,
  rememberRouteSearch,
  scopeNavigationAt,
  selectionInGraph,
  selectionWithChanges,
  singleSelectedEdgeId,
  singleSelectedNodeId,
  updateScopeNavigation,
  withCamera,
  withDesktopRevealLevel,
  withInspectorScroll,
  withInspectorSection,
  withoutDraftSelections,
  withSelection,
  withSelectionOpeningReveal,
  workspaceAddressFromSearch,
  workspaceKeyId,
  workspaceRouteSearch,
  type WorkflowNavigation,
  type WorkflowRouteSearch,
} from "#src/lib/workflow-navigation-state";

const graph = {
  nodes: [
    { id: "trigger", data: { type: "lifecycle" } },
    { id: "group_1", data: { type: "group" } },
    { id: "child", parentId: "group_1", data: { type: "action" } },
  ],
  edges: [{ id: "trigger-group_1" }],
};

function runAddress(executionId: string) {
  return workspaceAddressFromSearch("workflow_1", {
    view: "runs",
    executionId,
  });
}

describe("workspace addresses", () => {
  it("distinguishes Draft, the run list, a run, and a comparison", () => {
    const searches: WorkflowRouteSearch[] = [
      {},
      { view: "runs" },
      { view: "runs", executionId: "exec_1" },
      { view: "changes", compare: "version_1" },
      { view: "changes", compare: "version_1", group: "group_1" },
    ];
    const addresses = searches.map((search) =>
      workspaceAddressFromSearch("workflow_1", search)
    );

    expect(addresses.map((address) => workspaceKeyId(address.key))).toEqual([
      "draft",
      "runs",
      "run:exec_1",
      "comparison:version_1",
      "comparison:version_1",
    ]);
    expect(addresses.map(workspaceRouteSearch)).toEqual(searches);
  });
});

describe("updateScopeNavigation", () => {
  it("keeps the overview and one retained Group scope per key", () => {
    const overview = workspaceAddressFromSearch("workflow_1", {});
    const groupOne = workspaceAddressFromSearch("workflow_1", {
      group: "group_1",
    });
    const groupTwo = workspaceAddressFromSearch("workflow_1", {
      group: "group_2",
    });
    const select =
      (id: string) => (scope: Parameters<typeof withSelection>[0]) =>
        withSelection(scope, { nodeIds: [id], edgeIds: [] });

    let navigation = updateScopeNavigation(
      EMPTY_WORKFLOW_NAVIGATION,
      overview,
      select("trigger")
    );
    navigation = updateScopeNavigation(navigation, groupOne, select("child"));

    expect(scopeNavigationAt(navigation, overview).selection.nodeIds).toEqual([
      "trigger",
    ]);
    expect(scopeNavigationAt(navigation, groupOne).selection.nodeIds).toEqual([
      "child",
    ]);

    navigation = updateScopeNavigation(navigation, groupTwo, select("other"));
    expect(scopeNavigationAt(navigation, groupOne).selection).toEqual(
      EMPTY_SELECTION
    );
    expect(scopeNavigationAt(navigation, overview).selection.nodeIds).toEqual([
      "trigger",
    ]);
  });

  it("answers the same navigation when the update changes nothing", () => {
    const address = workspaceAddressFromSearch("workflow_1", {});
    const navigation = updateScopeNavigation(
      EMPTY_WORKFLOW_NAVIGATION,
      address,
      (scope) => withDesktopRevealLevel(scope, "closed")
    );

    expect(
      updateScopeNavigation(navigation, address, (scope) =>
        withDesktopRevealLevel(scope, "closed")
      )
    ).toBe(navigation);
    expect(
      updateScopeNavigation(navigation, address, (scope) =>
        withSelection(scope, { nodeIds: [], edgeIds: [] })
      )
    ).toBe(navigation);
  });

  it("evicts the oldest run keys while keeping the run Runs reopens", () => {
    let navigation: WorkflowNavigation = rememberRouteSearch(
      EMPTY_WORKFLOW_NAVIGATION,
      runAddress("exec_0")
    );
    navigation = updateScopeNavigation(
      navigation,
      runAddress("exec_0"),
      (scope) => withDesktopRevealLevel(scope, "closed")
    );
    for (let index = 1; index <= RETAINED_KEYS_PER_VIEW + 2; index++) {
      navigation = updateScopeNavigation(
        navigation,
        runAddress(`exec_${index}`),
        (scope) => withDesktopRevealLevel(scope, "browse")
      );
    }

    const runKeys = [...navigation.workspaces.keys()];
    expect(runKeys).toContain("run:exec_0");
    expect(runKeys).not.toContain("run:exec_1");
    expect(runKeys).not.toContain("run:exec_2");
    expect(runKeys).toHaveLength(RETAINED_KEYS_PER_VIEW + 1);
  });

  it("evicts the oldest comparison keys while keeping the comparison Changes reopens", () => {
    const comparisonAddress = (compare: string) =>
      workspaceAddressFromSearch("workflow_1", { view: "changes", compare });
    let navigation: WorkflowNavigation = rememberRouteSearch(
      EMPTY_WORKFLOW_NAVIGATION,
      comparisonAddress("version_0")
    );
    for (let index = 0; index <= RETAINED_KEYS_PER_VIEW + 2; index++) {
      navigation = updateScopeNavigation(
        navigation,
        comparisonAddress(`version_${index}`),
        (scope) => withDesktopRevealLevel(scope, "browse")
      );
    }
    navigation = updateScopeNavigation(
      navigation,
      runAddress("exec_1"),
      (scope) => withDesktopRevealLevel(scope, "browse")
    );

    const keys = [...navigation.workspaces.keys()];
    expect(keys).toContain("comparison:version_0");
    expect(keys).not.toContain("comparison:version_1");
    expect(keys).not.toContain("comparison:version_2");
    expect(keys.filter((key) => key.startsWith("comparison:"))).toHaveLength(
      RETAINED_KEYS_PER_VIEW + 1
    );
    expect(keys).toContain("run:exec_1");
  });
});

describe("selection", () => {
  it("applies React Flow select changes for nodes and edges", () => {
    const selection = selectionWithChanges(
      { nodeIds: ["a"], edgeIds: ["edge_1"] },
      {
        nodes: [
          { id: "b", selected: true },
          { id: "a", selected: false },
        ],
        edges: [{ id: "edge_1", selected: false }],
      }
    );

    expect(selection).toEqual({ nodeIds: ["b"], edgeIds: [] });
    expect(singleSelectedNodeId(selection)).toBe("b");
    expect(selectionWithChanges(selection, { nodes: [] })).toBe(selection);
  });

  it("names one object only when exactly one is selected", () => {
    expect(singleSelectedNodeId({ nodeIds: ["a", "b"], edgeIds: [] })).toBe(
      null
    );
    expect(singleSelectedNodeId({ nodeIds: ["a"], edgeIds: ["edge_1"] })).toBe(
      null
    );
    expect(singleSelectedEdgeId({ nodeIds: [], edgeIds: ["edge_1"] })).toBe(
      "edge_1"
    );
  });

  it("empties every Draft and comparison scope and keeps the rest", () => {
    const overview = workspaceAddressFromSearch("workflow_1", {});
    const group = workspaceAddressFromSearch("workflow_1", {
      group: "group_1",
    });
    const comparison = workspaceAddressFromSearch("workflow_1", {
      view: "changes",
      compare: "version_1",
    });
    const run = runAddress("exec_1");
    let navigation = updateScopeNavigation(
      EMPTY_WORKFLOW_NAVIGATION,
      overview,
      (scope) =>
        withDesktopRevealLevel(
          withSelection(scope, { nodeIds: ["a"], edgeIds: [] }),
          "closed"
        )
    );
    navigation = updateScopeNavigation(navigation, group, (scope) =>
      withSelection(scope, { nodeIds: ["child"], edgeIds: [] })
    );
    navigation = updateScopeNavigation(navigation, comparison, (scope) =>
      withSelection(scope, { nodeIds: ["a"], edgeIds: [] })
    );
    navigation = updateScopeNavigation(navigation, run, (scope) =>
      withSelection(scope, { nodeIds: ["run_step"], edgeIds: [] })
    );

    const cleared = withoutDraftSelections(navigation);

    expect(scopeNavigationAt(cleared, overview).selection).toEqual(
      EMPTY_SELECTION
    );
    expect(scopeNavigationAt(cleared, group).selection).toEqual(
      EMPTY_SELECTION
    );
    expect(scopeNavigationAt(cleared, comparison).selection).toEqual(
      EMPTY_SELECTION
    );
    expect(scopeNavigationAt(cleared, run).selection).toEqual({
      nodeIds: ["run_step"],
      edgeIds: [],
    });
    expect(scopeNavigationAt(cleared, overview).desktop.revealLevel).toBe(
      "closed"
    );
    expect(withoutDraftSelections(cleared)).toBe(cleared);
  });
});

describe("rememberRouteSearch", () => {
  it("remembers the last search of each view separately", () => {
    let navigation = rememberRouteSearch(
      EMPTY_WORKFLOW_NAVIGATION,
      runAddress("exec_1")
    );
    navigation = rememberRouteSearch(
      navigation,
      workspaceAddressFromSearch("workflow_1", {
        view: "changes",
        compare: "version_1",
      })
    );

    expect(navigation.searches).toEqual({
      runs: { view: "runs", executionId: "exec_1" },
      changes: { view: "changes", compare: "version_1" },
    });
    expect(rememberRouteSearch(navigation, runAddress("exec_1"))).toBe(
      navigation
    );
  });
});

describe("camera snapshots", () => {
  it("keeps desktop and mobile cameras apart", () => {
    const address = workspaceAddressFromSearch("workflow_1", {});
    const navigation = updateScopeNavigation(
      EMPTY_WORKFLOW_NAVIGATION,
      address,
      (scope) =>
        withCamera(
          withCamera(scope, "desktop", { centerX: 1, centerY: 2, zoom: 1 }),
          "mobile",
          { centerX: 3, centerY: 4, zoom: 0.5 }
        )
    );
    const scope = scopeNavigationAt(navigation, address);

    expect(scope.desktop.camera).toEqual({ centerX: 1, centerY: 2, zoom: 1 });
    expect(scope.mobile.camera).toEqual({ centerX: 3, centerY: 4, zoom: 0.5 });
  });
});

describe("recovery", () => {
  it("drops selected ids the graph no longer holds", () => {
    const selection = {
      nodeIds: ["child", "gone"],
      edgeIds: ["trigger-group_1"],
    };
    expect(selectionInGraph(selection, graph)).toEqual({
      nodeIds: ["child"],
      edgeIds: ["trigger-group_1"],
    });
    const kept = { nodeIds: ["child"], edgeIds: [] };
    expect(selectionInGraph(kept, graph)).toBe(kept);
  });

  it("accepts a focused scope only for a Group node", () => {
    expect(groupScopeExists({ kind: "group", groupId: "group_1" }, graph)).toBe(
      true
    );
    expect(groupScopeExists({ kind: "group", groupId: "child" }, graph)).toBe(
      false
    );
    expect(groupScopeExists({ kind: "overview" }, graph)).toBe(true);
  });

  it("keys structure on ids, kinds, and parents and ignores positions", () => {
    const moved = {
      ...graph,
      nodes: graph.nodes.map((node) => ({ ...node, position: { x: 9, y: 9 } })),
    };
    expect(graphStructureKey(moved)).toBe(graphStructureKey(graph));
    expect(
      graphStructureKey({
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.id === "child" ? { ...node, parentId: undefined } : node
        ),
      })
    ).not.toBe(graphStructureKey(graph));
  });

  it("settles a route on the nearest address the editor can open", () => {
    const base = {
      groupMissing: false,
      runMissing: false,
      missingComparisonBaseId: null,
      installedComparisonBaseId: undefined,
    };
    const valid: WorkflowRouteSearch = { view: "runs", executionId: "exec_1" };

    expect(recoveredRouteSearch({ ...base, search: valid })).toBe(valid);
    expect(
      recoveredRouteSearch({
        ...base,
        search: { group: "group_9" },
        groupMissing: true,
      })
    ).toEqual({});
    expect(
      recoveredRouteSearch({
        ...base,
        search: { ...valid, group: "group_1" },
        runMissing: true,
      })
    ).toEqual({ view: "runs" });
    expect(
      recoveredRouteSearch({
        ...base,
        search: { view: "changes", compare: "version_9" },
        missingComparisonBaseId: "version_9",
      })
    ).toEqual({ view: "changes" });
    // A refusal of another base leaves the named base alone.
    const retained: WorkflowRouteSearch = {
      view: "changes",
      compare: "version_1",
    };
    expect(
      recoveredRouteSearch({
        ...base,
        search: retained,
        missingComparisonBaseId: "version_9",
      })
    ).toBe(retained);
    expect(
      recoveredRouteSearch({
        ...base,
        search: { view: "changes" },
        installedComparisonBaseId: "version_2",
      })
    ).toEqual({ view: "changes", compare: "version_2" });
    // A named base the installed comparison does not match yet stays named.
    const named: WorkflowRouteSearch = {
      view: "changes",
      compare: "version_1",
    };
    expect(
      recoveredRouteSearch({
        ...base,
        search: named,
        installedComparisonBaseId: "version_2",
      })
    ).toBe(named);
  });
});

describe("cameraStep", () => {
  const draft = { addressId: "workflow_1|draft|overview" };
  const run = { addressId: "workflow_1|run:exec_1|overview" };
  const saved = { centerX: 10, centerY: 20, zoom: 0.8 };
  const placed = { moving: false, shownPlaced: true, nextPlaced: true };

  it.each(["desktop", "mobile"] as const)(
    "records the %s camera being left and restores the saved one",
    (formFactor) => {
      expect(
        cameraStep({
          ...placed,
          shown: { ...draft, formFactor },
          next: { ...run, formFactor },
          savedForNext: saved,
        })
      ).toEqual({ recordShown: true, restore: saved });
      expect(
        cameraStep({
          ...placed,
          shown: { ...draft, formFactor },
          next: { ...run, formFactor },
          savedForNext: null,
        })
      ).toEqual({ recordShown: true, restore: null });
    }
  );

  it("records under the old form factor across a breakpoint change", () => {
    expect(
      cameraStep({
        ...placed,
        shown: { ...draft, formFactor: "desktop" },
        next: { ...draft, formFactor: "mobile" },
        savedForNext: null,
      })
    ).toEqual({ recordShown: true, restore: null });
    expect(
      cameraStep({
        ...placed,
        shown: { ...draft, formFactor: "mobile" },
        next: { ...draft, formFactor: "desktop" },
        savedForNext: saved,
      })
    ).toEqual({ recordShown: true, restore: saved });
  });

  it("never records a camera mid-movement or before placement", () => {
    const step = {
      shown: { ...draft, formFactor: "desktop" as const },
      next: { ...run, formFactor: "desktop" as const },
      savedForNext: saved,
    };
    expect(cameraStep({ ...step, ...placed, moving: true })).toEqual({
      recordShown: false,
      restore: saved,
    });
    expect(
      cameraStep({ ...step, ...placed, shownPlaced: false, nextPlaced: false })
    ).toEqual({ recordShown: false, restore: null });
  });

  it("does nothing while the slot stays the same", () => {
    expect(
      cameraStep({
        ...placed,
        shown: { ...draft, formFactor: "desktop" },
        next: { ...draft, formFactor: "desktop" },
        savedForNext: saved,
      })
    ).toEqual({ recordShown: false, restore: null });
  });
});

describe("Canvas Reveal state", () => {
  const nodeSelection = (id: string) => ({ nodeIds: [id], edgeIds: [] });
  const EMPTY = scopeNavigationAt(
    EMPTY_WORKFLOW_NAVIGATION,
    workspaceAddressFromSearch("workflow_1", {})
  );

  it("remembers the open level a scope reopens at, and keeps it on close", () => {
    const focused = withDesktopRevealLevel(EMPTY, "focus");
    const closed = withDesktopRevealLevel(focused, "closed");
    expect(closed.desktop).toMatchObject({
      revealLevel: "closed",
      reopenLevel: "focus",
    });
    expect(withDesktopRevealLevel(closed, "browse").desktop.reopenLevel).toBe(
      "browse"
    );
  });

  it("opens at the reopen level when one object becomes the selection", () => {
    const closedFromFocus = withDesktopRevealLevel(
      withDesktopRevealLevel(EMPTY, "focus"),
      "closed"
    );
    const opened = withSelectionOpeningReveal(
      closedFromFocus,
      nodeSelection("step_a")
    );
    expect(opened.desktop).toMatchObject({
      revealLevel: "focus",
      inspected: { kind: "node", id: "step_a" },
    });
  });

  it("leaves the level alone for a multi-selection or an unchanged object", () => {
    const opened = withSelectionOpeningReveal(EMPTY, nodeSelection("step_a"));
    const closed = withDesktopRevealLevel(opened, "closed");

    const same = withSelectionOpeningReveal(closed, nodeSelection("step_a"));
    expect(same).toBe(closed);

    const multi = withSelectionOpeningReveal(closed, {
      nodeIds: ["step_a", "step_b"],
      edgeIds: [],
    });
    expect(multi.desktop.revealLevel).toBe("closed");
  });

  it("reopens the inspected object with its scroll after the selection emptied", () => {
    const opened = withInspectorScroll(
      withSelectionOpeningReveal(EMPTY, nodeSelection("step_a")),
      "browse",
      180
    );
    const cleared = withDesktopRevealLevel(
      withSelection(opened, EMPTY_SELECTION),
      "closed"
    );

    const again = withSelectionOpeningReveal(cleared, nodeSelection("step_a"));
    expect(again.desktop.revealLevel).toBe("browse");
    expect(again.desktop.inspectorScroll.browse).toBe(180);

    const other = withSelectionOpeningReveal(again, nodeSelection("step_b"));
    expect(other.desktop.inspectorScroll).toEqual({ browse: 0, focus: 0 });
  });

  it("keeps the inspected object's section and starts another object's over", () => {
    const opened = withInspectorSection(
      withSelectionOpeningReveal(EMPTY, nodeSelection("step_a")),
      "entity-eligibility"
    );
    expect(opened.desktop.inspectorSection).toBe("entity-eligibility");
    expect(withInspectorSection(opened, "entity-eligibility")).toBe(opened);

    const scrolled = withInspectorScroll(
      withInspectorScroll(opened, "browse", 90),
      "focus",
      240
    );
    expect(
      withInspectorSection(scrolled, "validation").desktop.inspectorScroll
    ).toEqual({ browse: 90, focus: 0 });

    const cleared = withSelection(opened, EMPTY_SELECTION);
    const again = withSelectionOpeningReveal(cleared, nodeSelection("step_a"));
    expect(again.desktop.inspectorSection).toBe("entity-eligibility");

    const other = withSelectionOpeningReveal(again, nodeSelection("step_b"));
    expect(other.desktop.inspectorSection).toBeNull();
    expect(
      inspectionInGraph(
        withInspectorSection(
          withSelectionOpeningReveal(EMPTY, nodeSelection("gone")),
          "validation"
        ),
        graph
      ).desktop.inspectorSection
    ).toBeNull();
  });

  it("forgets an inspected object the graph no longer holds", () => {
    const inspected = withInspectorScroll(
      withSelectionOpeningReveal(EMPTY, nodeSelection("gone")),
      "focus",
      90
    );
    const kept = withSelectionOpeningReveal(EMPTY, nodeSelection("child"));

    expect(inspectionInGraph(kept, graph)).toBe(kept);
    expect(inspectionInGraph(inspected, graph).desktop).toMatchObject({
      inspected: null,
      inspectorScroll: { browse: 0, focus: 0 },
    });
  });
});
