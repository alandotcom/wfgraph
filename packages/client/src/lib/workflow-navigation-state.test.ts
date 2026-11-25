import { describe, expect, it } from "vitest";
import {
  EMPTY_SELECTION,
  EMPTY_WORKFLOW_NAVIGATION,
  RETAINED_KEYS_PER_VIEW,
  cameraStep,
  inspectionInGraph,
  recoveredRouteSearch,
  rememberRouteSearch,
  workspaceNavigationAt,
  selectionInGraph,
  selectionWithChanges,
  updateWorkspaceNavigation,
  withCamera,
  withDesktopRevealLevel,
  withInspectedOrigin,
  withInspectorScroll,
  withInspectorSection,
  withChosenExecution,
  withoutDraftSelections,
  withInspectedSelection,
  workspaceAddressFromSearch,
  workspaceKeyId,
  workspaceRouteSearch,
  type WorkflowNavigation,
  type WorkflowRouteSearch,
} from "#src/lib/workflow-navigation-state";
import {
  singleSelectedEdgeId,
  singleSelectedNodeId,
  withSelection,
} from "#src/lib/canvas-selection";

const graph = {
  nodes: [
    { id: "trigger", data: { type: "lifecycle" } },
    { id: "group_1", data: { type: "group" } },
    { id: "child", parentId: "group_1", data: { type: "action" } },
  ],
  edges: [{ id: "trigger-group_1", target: "child" }],
};

function runAddress(executionId: string) {
  return workspaceAddressFromSearch("workflow_1", {
    view: "runs",
    executionId,
  });
}

describe("workspace addresses", () => {
  it("distinguishes Draft, the run list, and a run", () => {
    const searches: WorkflowRouteSearch[] = [
      {},
      { view: "runs" },
      { view: "runs", executionId: "exec_1" },
    ];
    const addresses = searches.map((search) =>
      workspaceAddressFromSearch("workflow_1", search)
    );

    expect(addresses.map((address) => workspaceKeyId(address.key))).toEqual([
      "draft",
      "runs",
      "run:exec_1",
    ]);
    expect(addresses.map(workspaceRouteSearch)).toEqual(searches);
  });

  it("reads an older link's Group key as the same address and never writes it", () => {
    const address = workspaceAddressFromSearch("workflow_1", {
      view: "runs",
      executionId: "exec_1",
      group: "group_1",
    });

    expect(workspaceRouteSearch(address)).toEqual({
      view: "runs",
      executionId: "exec_1",
    });
  });
});

describe("updateWorkspaceNavigation", () => {
  it("keeps one navigation per workspace key", () => {
    const draft = workspaceAddressFromSearch("workflow_1", {});
    const run = runAddress("exec_1");
    const select =
      (id: string) => (workspace: Parameters<typeof withSelection>[0]) =>
        withSelection(workspace, { nodeIds: [id], edgeIds: [] });

    let navigation = updateWorkspaceNavigation(
      EMPTY_WORKFLOW_NAVIGATION,
      draft,
      select("trigger")
    );
    navigation = updateWorkspaceNavigation(navigation, run, select("child"));

    expect(workspaceNavigationAt(navigation, draft).selection.nodeIds).toEqual([
      "trigger",
    ]);
    expect(workspaceNavigationAt(navigation, run).selection.nodeIds).toEqual([
      "child",
    ]);
  });

  it("answers the same navigation when the update changes nothing", () => {
    const address = workspaceAddressFromSearch("workflow_1", {});
    const navigation = updateWorkspaceNavigation(
      EMPTY_WORKFLOW_NAVIGATION,
      address,
      (scope) => withDesktopRevealLevel(scope, "focus")
    );

    expect(
      updateWorkspaceNavigation(navigation, address, (scope) =>
        withDesktopRevealLevel(scope, "focus")
      )
    ).toBe(navigation);
    expect(
      updateWorkspaceNavigation(navigation, address, (scope) =>
        withSelection(scope, { nodeIds: [], edgeIds: [] })
      )
    ).toBe(navigation);
  });

  it("evicts the oldest run keys while keeping the run Runs reopens", () => {
    let navigation: WorkflowNavigation = rememberRouteSearch(
      EMPTY_WORKFLOW_NAVIGATION,
      runAddress("exec_0")
    );
    navigation = updateWorkspaceNavigation(
      navigation,
      runAddress("exec_0"),
      (scope) => withDesktopRevealLevel(scope, "focus")
    );
    for (let index = 1; index <= RETAINED_KEYS_PER_VIEW + 2; index++) {
      navigation = updateWorkspaceNavigation(
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

  it("empties the Draft selection and keeps the rest", () => {
    const overview = workspaceAddressFromSearch("workflow_1", {});
    const run = runAddress("exec_1");
    let navigation = updateWorkspaceNavigation(
      EMPTY_WORKFLOW_NAVIGATION,
      overview,
      (scope) =>
        withDesktopRevealLevel(
          withSelection(scope, { nodeIds: ["a"], edgeIds: [] }),
          "focus"
        )
    );
    navigation = updateWorkspaceNavigation(navigation, run, (scope) =>
      withSelection(scope, { nodeIds: ["run_step"], edgeIds: [] })
    );

    const cleared = withoutDraftSelections(navigation);

    expect(workspaceNavigationAt(cleared, overview).selection).toEqual(
      EMPTY_SELECTION
    );
    expect(workspaceNavigationAt(cleared, run).selection).toEqual({
      nodeIds: ["run_step"],
      edgeIds: [],
    });
    expect(workspaceNavigationAt(cleared, overview).desktop.revealLevel).toBe(
      "focus"
    );
    expect(withoutDraftSelections(cleared)).toBe(cleared);
  });
});

describe("chosen run node executions", () => {
  const scope = workspaceNavigationAt(
    EMPTY_WORKFLOW_NAVIGATION,
    runAddress("e")
  );
  const execution = { nodeId: "step", logId: "log_1" };

  it("keeps a chosen execution while the selection holds its node alone", () => {
    const chosen = withChosenExecution(
      withSelection(scope, { nodeIds: ["step"], edgeIds: [] }),
      execution
    );

    expect(chosen.chosenExecution).toEqual(execution);
    expect(withChosenExecution(chosen, { ...execution })).toBe(chosen);
    expect(
      withSelection(chosen, { nodeIds: ["step"], edgeIds: [] }).chosenExecution
    ).toEqual(execution);
    expect(
      withSelection(chosen, { nodeIds: ["other"], edgeIds: [] }).chosenExecution
    ).toBeNull();
    expect(
      withSelection(chosen, { nodeIds: ["step", "other"], edgeIds: [] })
        .chosenExecution
    ).toBeNull();
    expect(withSelection(chosen, EMPTY_SELECTION).chosenExecution).toBeNull();
  });

  it("keeps an execution chosen with nothing selected until something is selected", () => {
    const chosen = withChosenExecution(scope, execution);

    expect(withSelection(chosen, EMPTY_SELECTION)).toBe(chosen);
    expect(
      withSelection(chosen, { nodeIds: ["other"], edgeIds: [] }).chosenExecution
    ).toBeNull();
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
      workspaceAddressFromSearch("workflow_1", {})
    );

    expect(navigation.searches).toEqual({
      runs: { view: "runs", executionId: "exec_1" },
      draft: {},
    });
    expect(rememberRouteSearch(navigation, runAddress("exec_1"))).toBe(
      navigation
    );
  });
});

describe("camera snapshots", () => {
  it("keeps desktop and mobile cameras apart", () => {
    const address = workspaceAddressFromSearch("workflow_1", {});
    const navigation = updateWorkspaceNavigation(
      EMPTY_WORKFLOW_NAVIGATION,
      address,
      (scope) =>
        withCamera(
          withCamera(scope, "desktop", { centerX: 1, centerY: 2, zoom: 1 }),
          "mobile",
          { centerX: 3, centerY: 4, zoom: 0.5 }
        )
    );
    const scope = workspaceNavigationAt(navigation, address);

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

  it("settles a route on the nearest address the editor can open", () => {
    const base = { runMissing: false };
    const valid: WorkflowRouteSearch = { view: "runs", executionId: "exec_1" };

    expect(recoveredRouteSearch({ ...base, search: valid })).toBe(valid);
    // An older link's Group key is always dropped.
    expect(
      recoveredRouteSearch({ ...base, search: { group: "group_9" } })
    ).toEqual({});
    expect(
      recoveredRouteSearch({
        ...base,
        search: { ...valid, group: "group_1" },
        runMissing: true,
      })
    ).toEqual({ view: "runs" });
  });
});

describe("cameraStep", () => {
  const draft = { addressId: "workflow_1|draft" };
  const run = { addressId: "workflow_1|run:exec_1" };
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

describe("details column state", () => {
  const nodeSelection = (id: string) => ({ nodeIds: [id], edgeIds: [] });
  const EMPTY = workspaceNavigationAt(
    EMPTY_WORKFLOW_NAVIGATION,
    workspaceAddressFromSearch("workflow_1", {})
  );

  it("records the level Runs shows", () => {
    const focused = withDesktopRevealLevel(EMPTY, "focus");
    expect(focused.desktop.revealLevel).toBe("focus");
    expect(withDesktopRevealLevel(focused, "focus")).toBe(focused);
  });

  it("inspects the object a selection comes to hold alone, and leaves the level alone", () => {
    const focused = withDesktopRevealLevel(EMPTY, "focus");
    const selected = withInspectedSelection(focused, nodeSelection("step_a"));
    expect(selected.desktop).toMatchObject({
      revealLevel: "focus",
      inspected: { kind: "node", id: "step_a" },
    });

    const same = withInspectedSelection(selected, nodeSelection("step_a"));
    expect(same).toBe(selected);

    const multi = withInspectedSelection(selected, {
      nodeIds: ["step_a", "step_b"],
      edgeIds: [],
    });
    expect(multi.desktop.inspected).toEqual({ kind: "node", id: "step_a" });
  });

  it("keeps the inspected object's scroll after the selection emptied", () => {
    const opened = withInspectorScroll(
      withInspectedSelection(EMPTY, nodeSelection("step_a")),
      "browse",
      180
    );
    const cleared = withSelection(opened, EMPTY_SELECTION);

    const again = withInspectedSelection(cleared, nodeSelection("step_a"));
    expect(again.desktop.inspectorScroll.browse).toBe(180);

    const other = withInspectedSelection(again, nodeSelection("step_b"));
    expect(other.desktop.inspectorScroll).toEqual({ browse: 0, focus: 0 });
  });

  it("keeps the inspected object's section and starts another object's over", () => {
    const opened = withInspectorSection(
      withInspectedSelection(EMPTY, nodeSelection("step_a")),
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
    const again = withInspectedSelection(cleared, nodeSelection("step_a"));
    expect(again.desktop.inspectorSection).toBe("entity-eligibility");

    const other = withInspectedSelection(again, nodeSelection("step_b"));
    expect(other.desktop.inspectorSection).toBeNull();
    expect(
      inspectionInGraph(
        withInspectorSection(
          withInspectedSelection(EMPTY, nodeSelection("gone")),
          "validation"
        ),
        graph
      ).desktop.inspectorSection
    ).toBeNull();
  });

  it("keeps the inspected object's origin across its own section changes and clears it for another object", () => {
    const origin = { nodeId: "split_a" };
    const opened = withInspectedOrigin(
      withInspectedSelection(EMPTY, nodeSelection("lifecycle_a")),
      origin
    );
    expect(opened.desktop.inspectedOrigin).toBe(origin);
    expect(withInspectedOrigin(opened, origin)).toBe(opened);

    const resectioned = withInspectorSection(opened, "start-events");
    expect(resectioned.desktop.inspectedOrigin).toBe(origin);

    const other = withInspectedSelection(opened, nodeSelection("step_b"));
    expect(other.desktop.inspectedOrigin).toBeNull();

    expect(inspectionInGraph(opened, graph).desktop.inspectedOrigin).toBeNull();
  });

  it("clears the origin when the selection stops holding the inspected object alone", () => {
    const opened = withInspectedOrigin(
      withInspectedSelection(EMPTY, nodeSelection("lifecycle_a")),
      { nodeId: "split_a" }
    );

    expect(
      withDesktopRevealLevel(opened, "focus").desktop.inspectedOrigin
    ).not.toBeNull();

    const cleared = withInspectedSelection(opened, EMPTY_SELECTION);
    expect(cleared.desktop.inspectedOrigin).toBeNull();
    const reselected = withInspectedSelection(
      cleared,
      nodeSelection("lifecycle_a")
    );
    expect(reselected.desktop.inspectedOrigin).toBeNull();

    const widened = withSelection(opened, {
      nodeIds: ["lifecycle_a", "step_b"],
      edgeIds: [],
    });
    expect(widened.desktop.inspectedOrigin).toBeNull();
  });

  it("forgets an inspected object the graph no longer holds", () => {
    const inspected = withInspectorScroll(
      withInspectedSelection(EMPTY, nodeSelection("gone")),
      "focus",
      90
    );
    const kept = withInspectedSelection(EMPTY, nodeSelection("child"));

    expect(inspectionInGraph(kept, graph)).toBe(kept);
    expect(inspectionInGraph(inspected, graph).desktop).toMatchObject({
      inspected: null,
      inspectorScroll: { browse: 0, focus: 0 },
    });
  });
});
