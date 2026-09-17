import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import type { WorkflowNode as PersistedWorkflowNode } from "@wfgraph/shared/graph/types";
import { canvasInteractionState } from "#src/components/workflow/canvas-interaction";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import {
  beginWorkflowComparisonRequestAtom,
  comparisonSessionAtom,
  installWorkflowComparisonAtom,
  settleWorkflowComparisonRequestAtom,
} from "#src/lib/workflow-comparison-store";
import type { WorkflowRouteSearch } from "#src/lib/workflow-navigation-state";
import {
  activeMobileSheetsAtom,
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
  activeWorkspaceCamerasAtom,
  openMobileSelectionAtom,
  recordWorkspaceCameraAtom,
} from "#src/lib/workflow-workspace-navigation";
import { changesMobileSheet } from "./changes-summary";
import {
  CHANGES_WORKFLOW_ID,
  changesStep,
  installComparison,
  renderChangesReveal,
  stubComparisonServer,
} from "./changes-reveal.test-support";

const CHANGES_V3: WorkflowRouteSearch = {
  view: "changes",
  compare: "version_3",
};

const catalog: ExtensionCatalog = {
  entities: [],
  events: [],
  integrations: [],
  actions: [
    {
      id: "mail/send",
      label: "Send email",
      description: "",
      category: "Mail",
      configFields: [{ key: "subject", label: "Subject", type: "text" }],
      outputFields: [],
    },
  ],
};

function email(
  id: string,
  label: string,
  subject: string
): PersistedWorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label,
      type: "action",
      config: { actionType: "mail/send", subject },
    },
  };
}

/**
 * A published version against the draft: "Fresh" added, "Reminder" modified
 * (its label and subject), "Gone" removed, and "Kept" unchanged with one
 * connection added and one removed.
 */
function comparisonAgainst(version: number): WorkflowComparisonPayload {
  return {
    baseVersion: {
      id: `version_${version}`,
      version,
      publishedAt: "2026-09-01T00:00:00.000Z",
      isCurrent: version === 3,
    },
    proposedVersion: 4,
    baseGraph: createSerializedWorkflowGraph({
      nodes: [
        changesStep("kept", "Kept"),
        changesStep("gone", "Gone"),
        email("reminder", "Old reminder", "Before"),
      ],
      edges: [{ id: "kept-gone", source: "kept", target: "gone" }],
    }),
    draftGraph: createSerializedWorkflowGraph({
      nodes: [
        changesStep("kept", "Kept"),
        email("reminder", "Reminder", "After"),
        email("fresh", "Fresh", "Welcome"),
      ],
      edges: [{ id: "kept-fresh", source: "kept", target: "fresh" }],
    }),
    hasChanges: true,
    nodeChanges: [
      { nodeId: "fresh", kind: "added", fields: [] },
      {
        nodeId: "reminder",
        kind: "modified",
        fields: [
          {
            path: ["data", "label"],
            kind: "modified",
            before: "Old reminder",
            after: "Reminder",
          },
          {
            path: ["data", "config", "subject"],
            kind: "modified",
            before: "Before",
            after: "After",
          },
        ],
      },
      { nodeId: "gone", kind: "removed", fields: [] },
    ],
    edgeChanges: [
      { edgeId: "kept-fresh", kind: "added" },
      { edgeId: "kept-gone", kind: "removed" },
    ],
  };
}

/** Happy-dom's viewport, which the `md` media query answers from. */
function setViewportWidth(width: number): void {
  (
    window as unknown as {
      happyDOM: { setViewport: (viewport: { width: number }) => void };
    }
  ).happyDOM.setViewport({ width });
}

async function renderMobileChanges(options?: {
  installed?: WorkflowComparisonPayload | undefined;
  draftNodes?: readonly PersistedWorkflowNode[] | undefined;
  workflowCanvas?: boolean | undefined;
}) {
  const installed = options?.installed ?? comparisonAgainst(3);
  const server = stubComparisonServer(installed);
  const rendered = await renderChangesReveal({
    search: CHANGES_V3,
    installed,
    draftNodes: options?.draftNodes ?? [changesStep("kept", "Kept")],
    catalog,
    mobile: true,
    workflowCanvas: options?.workflowCanvas,
  });
  const { view, store } = rendered;
  const sheet = () =>
    view.container.querySelector<HTMLElement>('[data-slot="mobile-reveal"]');
  const inSheet = () => {
    const element = sheet();
    if (!element) {
      throw new Error("no mobile sheet is on screen");
    }
    return within(element);
  };
  const press = (name: string | RegExp) =>
    fireEvent.click(inSheet().getByRole("button", { name }));
  const heading = () =>
    sheet()?.querySelector('[data-slot="reveal-title"]')?.textContent;
  /** The status line under the sheet's title. */
  const status = () =>
    sheet()?.querySelector('[data-slot="reveal-title"]')?.nextElementSibling
      ?.textContent;
  /** Which Changes sheet each open sheet is, the first opened first. */
  const sheets = () =>
    store.get(activeMobileSheetsAtom).map(changesMobileSheet);
  const scroller = () =>
    sheet()?.querySelector<HTMLElement>(".overflow-y-auto") ?? null;
  const scrollTo = (top: number) => {
    const body = scroller();
    if (!body) {
      throw new Error("no sheet body is on screen");
    }
    body.scrollTop = top;
    fireEvent.scroll(body);
    fireEvent(body, new Event("scrollend"));
  };
  /** Open the comparison summary, as the toolbar's Configuration does. */
  const openSummary = async () => {
    await act(async () => {
      store.set(openMobileSelectionAtom, store.get(activeWorkspaceAddressAtom));
    });
  };
  const canvasNode = (label: string) =>
    view.getByRole("button", { name: `Canvas ${label}` });
  /** The node React Flow draws for `id` on the real canvas. */
  const flowNode = (id: string) =>
    waitFor(() => {
      const element = view.container.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${CSS.escape(id)}"]`
      );
      if (!element) {
        throw new Error(`node ${id} is not on the canvas`);
      }
      return element;
    });
  /**
   * Drag `element` 100px right and 80px down with a mouse, as React Flow's
   * drag handler hears a pointer drag.
   *
   * React Flow auto-pans during a node drag with a loop of animation frames.
   * The loop awaits each pan before it asks for the next frame, so a drag that
   * ends during that await leaves a frame loop running into later test files
   * in this worker. The drag holds animation frames back until every pan has
   * settled; the node positions these tests read come from the drag events.
   */
  const drag = async (element: HTMLElement) => {
    const frames = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockReturnValue(0);
    try {
      await dispatchDrag(element);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    } finally {
      frames.mockRestore();
    }
  };
  const dispatchDrag = async (element: HTMLElement) => {
    const at = (x: number, y: number) => ({
      button: 0,
      buttons: 1,
      clientX: x,
      clientY: y,
      view: window,
    });
    await act(async () => {
      fireEvent.pointerDown(element, at(10, 10));
      fireEvent.mouseDown(element, at(10, 10));
      for (const [x, y] of [
        [30, 25],
        [70, 55],
        [110, 90],
      ] as const) {
        fireEvent.pointerMove(element, at(x, y));
        fireEvent.mouseMove(window, at(x, y));
      }
      fireEvent.pointerUp(element, at(110, 90));
      fireEvent.mouseUp(window, at(110, 90));
    });
  };
  /** Each stacked setting as its label followed by each side's name and value. */
  const settings = (name: string) =>
    within(inSheet().getByRole("list", { name }))
      .getAllByRole("listitem")
      .map((item) =>
        [...item.querySelectorAll("p, dt, dd")].map(
          (element) => element.textContent
        )
      );
  return {
    ...rendered,
    server,
    sheet,
    inSheet,
    press,
    heading,
    status,
    sheets,
    scroller,
    scrollTo,
    openSummary,
    canvasNode,
    flowNode,
    drag,
    settings,
  };
}

beforeEach(() => {
  setViewportWidth(390);
  installAuthorizationGrantsForTests([
    WfGraphOperations.workflowCompareVersion.id,
    WfGraphOperations.workflowGetVersionHistory.id,
  ]);
});

afterEach(() => {
  setViewportWidth(1440);
  vi.unstubAllGlobals();
  resetAuthorizationGrantsForTests();
});

describe("mobile Changes sequence", () => {
  it("moves from the comparison summary to the change list to stacked field differences, and goes Back one sheet at a time", async () => {
    const view = await renderMobileChanges();
    expect(
      view.view.container.querySelector('[data-slot="canvas-reveal"]')
    ).toBeNull();

    await view.openSummary();
    const summary = view.view.getByRole("region", {
      name: "Changes inspector",
    });
    expect(summary.dataset.level).toBe("summary");
    expect(view.heading()).toBe("Version 3 → proposed version 4");
    expect(
      view.inSheet().getByRole("region", { name: "Comparison summary" })
    ).toBeTruthy();
    expect(view.inSheet().queryByRole("button", { name: /^Back/ })).toBeNull();

    view.press("Review 5 changes");
    expect(view.sheets()).toEqual(["summary", "changes"]);
    expect(view.sheet()?.dataset.level).toBe("summary");
    expect(view.heading()).toBe("Changes");
    expect(
      within(view.inSheet().getByRole("region", { name: "Changed steps" }))
        .getAllByRole("button")
        .map((row) => row.textContent)
    ).toEqual(["AFreshAdded", "MReminderModified", "DGoneRemoved"]);

    view.press("Reminder Modified");
    expect(view.sheets()).toEqual(["summary", "changes", "change"]);
    expect(view.sheet()?.dataset.level).toBe("inspector");
    expect(view.heading()).toBe("Reminder");
    expect(view.status()).toBe("Modified");
    expect(view.inSheet().queryByRole("table")).toBeNull();
    expect(view.settings("Settings of this step")).toEqual([
      ["Label", "Version 3", "Old reminder", "Current draft", "Reminder"],
      ["Subject", "Version 3", "Before", "Current draft", "After"],
    ]);

    view.press("Back to Changes");
    expect(view.sheets()).toEqual(["summary", "changes"]);
    view.press("Back to Summary");
    expect(view.sheet()?.dataset.level).toBe("summary");
    view.press("Close");
    expect(view.sheet()).toBeNull();
    expect(view.store.get(activeSelectionAtom)).toEqual({
      nodeIds: ["reminder"],
      edgeIds: [],
    });
  });

  it("goes Back one sheet on Escape", async () => {
    const view = await renderMobileChanges();
    await view.openSummary();
    view.press("Review 5 changes");
    view.press("Fresh Added");

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Escape", bubbles: true });
    });
    expect(view.sheets()).toEqual(["summary", "changes"]);
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Escape", bubbles: true });
    });
    expect(view.sheets()).toEqual(["summary"]);
  });

  it("opens a changed step tapped on the canvas over the comparison summary", async () => {
    const view = await renderMobileChanges();
    fireEvent.click(view.canvasNode("Reminder"));

    expect(view.sheets()).toEqual(["summary", "change"]);
    expect(view.heading()).toBe("Reminder");
    view.press("Back to Summary");
    expect(view.heading()).toBe("Version 3 → proposed version 4");
    expect(view.store.get(activeSelectionAtom).nodeIds).toEqual(["reminder"]);
  });

  it("moves between changed objects in the field differences sheet without adding a sheet", async () => {
    const view = await renderMobileChanges();
    await view.openSummary();
    view.press("Review 5 changes");
    view.press("Reminder Modified");

    view.press("Next change");
    expect(view.sheets()).toEqual(["summary", "changes", "change"]);
    expect(view.heading()).toBe("Gone");
    expect(view.store.get(activeSelectionAtom).nodeIds).toEqual(["gone"]);

    view.press("Next change");
    expect(view.heading()).toBe("Kept → Fresh");
    expect(view.settings("This connection")).toEqual([
      ["From", "Current draft", "Kept"],
      ["To", "Current draft", "Fresh"],
    ]);
    expect(view.store.get(activeSelectionAtom).edgeIds).toEqual(["kept-fresh"]);
  });
});

describe("mobile Changes restoration", () => {
  it("restores the list scroll and the selection on Back, leaves the camera, and focuses the row of the object shown last", async () => {
    const view = await renderMobileChanges();
    await view.openSummary();
    view.press("Review 5 changes");
    view.scrollTo(40);
    const camera = { centerX: 120, centerY: 80, zoom: 0.8 };
    act(() => {
      view.store.set(recordWorkspaceCameraAtom, {
        address: view.store.get(activeWorkspaceAddressAtom),
        formFactor: "mobile",
        camera,
      });
    });

    view.press("Fresh Added");
    await waitFor(() => expect(view.scroller()?.scrollTop).toBe(0));
    view.press("Next change");

    view.press("Back to Changes");
    await waitFor(() => expect(view.scroller()?.scrollTop).toBe(40));
    expect(view.store.get(activeWorkspaceCamerasAtom).mobile).toEqual(camera);
    expect(view.store.get(activeSelectionAtom).nodeIds).toEqual(["reminder"]);
    expect(
      view
        .inSheet()
        .getByRole("button", { name: "Reminder Modified" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("MReminderModified")
    );
  });

  it("opens version history and returns to the exact comparison context", async () => {
    const view = await renderMobileChanges();
    await view.openSummary();
    view.scrollTo(24);
    view.press("Version history");
    expect(view.sheets()).toEqual(["summary", "history"]);
    expect(view.heading()).toBe("Version history");
    expect(view.sheet()?.dataset.level).toBe("inspector");
    expect(view.canvasNode("Kept").closest("[inert]")).not.toBeNull();
    const version2 = await view.inSheet().findByRole("button", {
      name: /^Version 2/,
    });

    view.press("Back to Summary");
    expect(view.sheets()).toEqual(["summary"]);
    await waitFor(() => expect(view.scroller()?.scrollTop).toBe(24));
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Version history")
    );
    expect(view.canvasNode("Kept").closest("[inert]")).toBeNull();

    view.press("Version history");
    expect(version2.isConnected).toBe(false);
    fireEvent.click(
      await view.inSheet().findByRole("button", { name: /^Version 2/ })
    );
    const version2Search = { view: "changes", compare: "version_2" } as const;
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual(version2Search)
    );
    await view.show(version2Search);
    expect(view.sheets()).toEqual(["summary"]);

    await view.show(CHANGES_V3);
    expect(view.sheets()).toEqual(["summary"]);
    expect(view.heading()).toBe("Version 3 → proposed version 4");
  });

  it("keeps one summary sheet per comparison across repeated version history round trips", async () => {
    const view = await renderMobileChanges();
    await view.openSummary();
    const chooseVersion = async (
      version: number,
      search: WorkflowRouteSearch
    ) => {
      view.press("Version history");
      expect(view.sheets()).toEqual(["summary", "history"]);
      fireEvent.click(
        await view
          .inSheet()
          .findByRole("button", { name: new RegExp(`^Version ${version}`) })
      );
      expect(view.sheets()).toEqual(["summary"]);
      await waitFor(() =>
        expect(view.router.state.location.search).toEqual(search)
      );
      await view.show(search);
      act(() => installComparison(view.store, comparisonAgainst(version)));
      expect(view.sheets()).toEqual(["summary"]);
      expect(view.heading()).toBe(`Version ${version} → proposed version 4`);
    };
    const version2 = { view: "changes", compare: "version_2" } as const;

    await chooseVersion(2, version2);
    await chooseVersion(3, CHANGES_V3);
    await chooseVersion(2, version2);
    await chooseVersion(3, CHANGES_V3);

    // Choosing the version already compared refreshes it and leaves history.
    view.press("Version history");
    fireEvent.click(
      await view.inSheet().findByRole("button", { name: /^Version 3/ })
    );
    expect(view.sheets()).toEqual(["summary"]);
    expect(view.router.state.location.search).toEqual(CHANGES_V3);
  });

  it("carries the summary and change list into a Group's scope when a member is chosen, so Back reaches the list", async () => {
    const frame: PersistedWorkflowNode = {
      id: "group",
      type: "group",
      position: { x: 0, y: 0 },
      data: { label: "Follow-ups", type: "group", config: {} },
    };
    const member = (subject: string): PersistedWorkflowNode => ({
      ...email("member", "Member", subject),
      parentId: "group",
    });
    const draftNodes = [frame, member("After"), changesStep("kept", "Kept")];
    const view = await renderMobileChanges({
      draftNodes,
      installed: {
        ...comparisonAgainst(3),
        baseGraph: createSerializedWorkflowGraph({
          nodes: [frame, member("Before"), changesStep("kept", "Kept")],
          edges: [],
        }),
        draftGraph: createSerializedWorkflowGraph({
          nodes: draftNodes,
          edges: [],
        }),
        nodeChanges: [
          {
            nodeId: "member",
            kind: "modified",
            fields: [
              {
                path: ["data", "config", "subject"],
                kind: "modified",
                before: "Before",
                after: "After",
              },
            ],
          },
        ],
        edgeChanges: [],
      },
    });
    await view.openSummary();
    view.press("Review 1 change");

    view.press("Member Modified");
    const groupSearch = view.router.state.location.search;
    expect(groupSearch).toMatchObject({ view: "changes", group: "group" });
    await view.show(groupSearch);
    expect(view.sheets()).toEqual(["summary", "changes", "change"]);
    expect(view.heading()).toBe("Member");

    view.press("Back to Changes");
    expect(view.sheets()).toEqual(["summary", "changes"]);
    expect(
      view
        .inSheet()
        .getByRole("button", { name: "Member Modified" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    view.press("Back to Summary");
    expect(view.sheets()).toEqual(["summary"]);
  });

  it("restores the comparison identity and sheet depth after visiting Draft", async () => {
    const view = await renderMobileChanges();
    await view.openSummary();
    view.press("Review 5 changes");
    view.press("Reminder Modified");

    await view.show({});
    expect(view.sheet()).toBeNull();
    await view.show(CHANGES_V3);

    expect(view.sheets()).toEqual(["summary", "changes", "change"]);
    expect(view.heading()).toBe("Reminder");
    expect(view.store.get(activeWorkspaceAddressAtom).key).toEqual({
      workspace: "changes",
      baseVersionId: "version_3",
    });
  });

  it("never shows another comparison while the named one loads, and ignores a late answer for another base", async () => {
    const view = await renderMobileChanges();
    const { store } = view;
    await view.openSummary();
    view.press("Review 5 changes");
    const staleEpoch = store.set(
      beginWorkflowComparisonRequestAtom,
      CHANGES_WORKFLOW_ID
    );

    const version1 = { view: "changes", compare: "version_1" } as const;
    await view.show(version1);
    const epoch = store.set(
      beginWorkflowComparisonRequestAtom,
      CHANGES_WORKFLOW_ID
    );
    await view.openSummary();
    await waitFor(() => expect(view.heading()).toBe("Comparing changes"));
    expect(
      view.inSheet().queryByRole("button", { name: /^Review/ })
    ).toBeNull();

    await act(async () => {
      expect(
        store.set(installWorkflowComparisonAtom, {
          workflowId: CHANGES_WORKFLOW_ID,
          epoch: staleEpoch,
          payload: comparisonAgainst(2),
        })
      ).toBe(false);
    });
    expect(view.heading()).toBe("Comparing changes");

    await act(async () => {
      store.set(installWorkflowComparisonAtom, {
        workflowId: CHANGES_WORKFLOW_ID,
        epoch,
        payload: comparisonAgainst(1),
      });
      store.set(settleWorkflowComparisonRequestAtom, {
        workflowId: CHANGES_WORKFLOW_ID,
        epoch,
      });
    });
    expect(view.heading()).toBe("Version 1 → proposed version 4");

    await view.show(CHANGES_V3);
    expect(view.sheets()).toEqual(["summary", "changes"]);
    expect(view.heading()).toBe("No comparison open");
    expect(
      view.inSheet().queryByRole("button", { name: "Reminder Modified" })
    ).toBeNull();
  });
});

describe("mobile Changes states at phone width", () => {
  it("shows an added step's draft values alone and a removed step's published values alone", async () => {
    const view = await renderMobileChanges();
    fireEvent.click(view.canvasNode("Fresh"));
    expect(view.status()).toBe("Added");
    expect(
      view.inSheet().getByText(/This step is new in the draft/)
    ).toBeTruthy();
    expect(
      view
        .settings("Settings of this step")
        .every((row) => !row.includes("Version 3"))
    ).toBe(true);

    expect(
      view.inSheet().getByRole("button", { name: "Previous change" })
    ).toHaveProperty("disabled", true);
    view.press("Next change");
    view.press("Next change");
    expect(view.heading()).toBe("Gone");
    expect(view.status()).toBe("Removed");
    expect(
      view.inSheet().getByText(/This step is removed from the draft/)
    ).toBeTruthy();
  });

  it("marks a masked value as hidden and says when the comparison lacks a side's values", async () => {
    const payload = comparisonAgainst(3);
    const view = await renderMobileChanges({
      installed: {
        ...payload,
        nodeChanges: [
          ...payload.nodeChanges.map((change) =>
            change.nodeId === "reminder"
              ? {
                  ...change,
                  fields: [
                    {
                      path: ["data", "config", "subject"],
                      kind: "modified" as const,
                      before: "****",
                      after: "********oken",
                    },
                  ],
                }
              : change
          ),
          { nodeId: "kept", kind: "added" as const, fields: [] },
        ],
        draftGraph: createSerializedWorkflowGraph({
          nodes: [email("reminder", "Reminder", "********oken")],
          edges: [],
        }),
      },
    });
    fireEvent.click(view.canvasNode("Reminder"));
    expect(view.settings("Settings of this step")).toEqual([
      [
        "Subject",
        "Version 3",
        "Hidden for security",
        "Current draft",
        "Hidden for security",
      ],
    ]);

    fireEvent.click(view.canvasNode("Kept"));
    expect(
      view.sheet()?.querySelector("[data-state=unavailable]")?.textContent
    ).toBe(
      "The draft's values for this step are not available in this comparison."
    );
  });

  it("says an Organization-only comparison leaves execution behavior unchanged", async () => {
    const frame = (
      label: string,
      direction: string
    ): PersistedWorkflowNode => ({
      id: "group",
      type: "group",
      position: { x: 0, y: 0 },
      data: { label, type: "group", config: { direction } },
    });
    const inGroup = (node: PersistedWorkflowNode): PersistedWorkflowNode => ({
      ...node,
      parentId: "group",
    });
    const draftNodes = [
      frame("Follow-ups", "vertical"),
      inGroup(changesStep("inner", "Inner")),
      inGroup(changesStep("moved", "Moved")),
    ];
    const view = await renderMobileChanges({
      draftNodes,
      installed: {
        ...comparisonAgainst(3),
        baseGraph: createSerializedWorkflowGraph({
          nodes: [
            frame("Reminders", "vertical"),
            inGroup(changesStep("inner", "Inner")),
            changesStep("moved", "Moved"),
          ],
          edges: [],
        }),
        draftGraph: createSerializedWorkflowGraph({
          nodes: draftNodes,
          edges: [],
        }),
        nodeChanges: [
          {
            nodeId: "group",
            kind: "modified",
            fields: [
              {
                path: ["data", "label"],
                kind: "modified",
                before: "Reminders",
                after: "Follow-ups",
              },
            ],
          },
          {
            nodeId: "moved",
            kind: "modified",
            fields: [{ path: ["parentId"], kind: "added", after: "group" }],
          },
        ],
        edgeChanges: [],
      },
    });
    await view.openSummary();
    expect(
      view.inSheet().getByRole("region", { name: "Comparison summary" })
        .textContent
    ).toContain(
      "Execution behavior is unchanged. Only how steps are organized in Groups differs."
    );

    view.press("Review 2 changes");
    expect(
      within(
        view.inSheet().getByRole("region", { name: "Changed steps" })
      ).getByRole("button", { name: "Moved Group membership" })
    ).toBeTruthy();
    view.press("Follow-ups Modified");
    expect(view.heading()).toBe("Follow-ups");
    expect(
      view.inSheet().getByText(/execution behavior is unchanged/)
    ).toBeTruthy();
  });
});

describe("mobile Changes accessibility and authoring", () => {
  it("leaves a removed step in place when it is dragged on a phone's canvas", async () => {
    const view = await renderMobileChanges({ workflowCanvas: true });
    const gone = await view.flowNode("gone");
    const transform = gone.style.transform;

    await view.drag(gone);

    expect(view.store.get(comparisonSessionAtom)?.positionOverrides).toEqual(
      {}
    );
    expect((await view.flowNode("gone")).style.transform).toBe(transform);
    expect(gone.classList.contains("draggable")).toBe(false);
  });

  it("moves a removed step dragged on a desktop canvas and keeps draft steps in place", async () => {
    setViewportWidth(1440);
    const view = await renderMobileChanges({ workflowCanvas: true });
    const gone = await view.flowNode("gone");
    const kept = await view.flowNode("kept");
    expect(gone.classList.contains("draggable")).toBe(true);

    await view.drag(kept);
    await view.drag(gone);

    const overrides = view.store.get(comparisonSessionAtom)?.positionOverrides;
    expect(Object.keys(overrides ?? {})).toEqual(["gone"]);
  });

  it("moves focus to each sheet's title and takes the canvas out of navigation under the field differences", async () => {
    const view = await renderMobileChanges();
    await view.openSummary();
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe(
        "Version 3 → proposed version 4"
      )
    );
    expect(view.canvasNode("Kept").closest("[inert]")).toBeNull();

    view.press("Review 5 changes");
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Changes")
    );
    view.press("Kept → Gone Removed");
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Kept → Gone")
    );
    expect(view.canvasNode("Kept").closest("[inert]")).not.toBeNull();
    const region = view.view.getByRole("region", {
      name: "Changes inspector",
    });
    const reachable = [
      ...view.view.container.querySelectorAll<HTMLElement>(
        "button, input, [tabindex]:not([tabindex='-1'])"
      ),
    ].filter((element) => element.closest("[inert]") === null);
    expect(reachable.every((element) => region.contains(element))).toBe(true);

    view.press("Back to Changes");
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("DKept → GoneRemoved")
    );
  });

  it("offers no topology-authoring command or gesture", async () => {
    const view = await renderMobileChanges();
    const topologyCommand =
      /^(Delete|Ungroup|Group|Add step|Tidy layout|Reset comparison layout)/;
    await view.openSummary();
    expect(
      view.inSheet().queryByRole("button", { name: topologyCommand })
    ).toBeNull();
    view.press("Review 5 changes");
    view.press("Reminder Modified");
    expect(
      view.inSheet().queryByRole("button", { name: topologyCommand })
    ).toBeNull();

    const interaction = canvasInteractionState({
      editingLocked: true,
      comparisonActive: true,
      overlayActive: false,
      groupScopeActive: false,
      topologyAuthoring: false,
    });
    expect(interaction).toMatchObject({
      insertsNodes: false,
      editsTopology: false,
      nodesDraggable: false,
      deleteKeyCode: null,
      multiSelectionKeyCode: null,
      selectionKeyCode: null,
    });
  });
});
