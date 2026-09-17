import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { serializeConditionModel } from "@wfgraph/shared/conditions/conditions";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import type { WorkflowNode as PersistedWorkflowNode } from "@wfgraph/shared/graph/types";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import {
  beginWorkflowComparisonRequestAtom,
  installWorkflowComparisonAtom,
  settleWorkflowComparisonRequestAtom,
} from "#src/lib/workflow-comparison-store";
import { selectOnlyNodeAtom } from "#src/lib/workflow-graph-store";
import {
  workspaceAddressFromSearch,
  workspaceAddressId,
  type WorkflowRouteSearch,
} from "#src/lib/workflow-navigation-state";
import {
  activeSelectionAtom,
  activeWorkspaceCamerasAtom,
  recordWorkspaceCameraAtom,
} from "#src/lib/workflow-workspace-navigation";
import { changeRowFocusRequestAtom } from "./changes-summary";
import {
  CHANGES_WORKFLOW_ID,
  changesStep,
  renderChangesReveal,
  stubComparisonServer,
} from "./changes-reveal.test-support";

const CHANGES_V3: WorkflowRouteSearch = {
  view: "changes",
  compare: "version_3",
};

const LONG_SUBJECT = `Your appointment ${"is tomorrow ".repeat(30)}`;

const BOOKED = "app/appointment.booked";
const CANCELED = "app/appointment.canceled";

const catalog: ExtensionCatalog = {
  entities: [
    {
      type: "patient",
      label: "Patient",
      stateFields: [{ path: "status", type: "string" }],
      stateSchemaDigest: "digest",
    },
  ],
  events: [
    {
      name: BOOKED,
      label: "Appointment booked",
      payloadFields: [{ path: "appointment.channel", type: "string" }],
    },
    {
      name: CANCELED,
      label: "Appointment canceled",
      payloadFields: [{ path: "appointment.channel", type: "string" }],
    },
  ],
  integrations: [],
  actions: [
    {
      id: "mail/send",
      label: "Send email",
      description: "",
      category: "Mail",
      configFields: [
        { key: "subject", label: "Subject", type: "text", required: true },
      ],
      outputFields: [],
    },
  ],
};

function email(
  id: string,
  label: string,
  config: Record<string, string>
): PersistedWorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label,
      type: "action",
      config: { actionType: "mail/send", ...config },
    },
  };
}

/**
 * Version 3 against the draft: "Fresh" added, "Reminder" modified (its subject
 * cleared and its label changed), "Gone" removed, "Legacy" modified under an
 * action the catalog no longer has, "Kept" unchanged with one connection added
 * and one removed.
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
        email("reminder", "Old reminder", { subject: LONG_SUBJECT }),
        {
          ...changesStep("legacy", "Legacy"),
          data: {
            label: "Legacy",
            type: "action",
            config: { actionType: "old/removed", tone: "warm" },
          },
        },
      ],
      edges: [{ id: "kept-gone", source: "kept", target: "gone" }],
    }),
    draftGraph: createSerializedWorkflowGraph({
      nodes: [
        changesStep("kept", "Kept"),
        email("reminder", "Reminder", { subject: "" }),
        email("fresh", "Fresh", { subject: "Welcome" }),
        {
          ...changesStep("legacy", "Legacy"),
          data: {
            label: "Legacy",
            type: "action",
            config: { actionType: "old/removed", tone: "cool" },
          },
        },
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
            before: LONG_SUBJECT,
            after: "",
          },
        ],
      },
      { nodeId: "gone", kind: "removed", fields: [] },
      {
        nodeId: "legacy",
        kind: "modified",
        fields: [
          {
            path: ["data", "config", "tone"],
            kind: "modified",
            before: "warm",
            after: "cool",
          },
        ],
      },
    ],
    edgeChanges: [
      { edgeId: "kept-fresh", kind: "added" },
      { edgeId: "kept-gone", kind: "removed" },
    ],
  };
}

function renderFocus(options?: {
  installed?: WorkflowComparisonPayload;
  draftNodes?: readonly PersistedWorkflowNode[];
}) {
  stubComparisonServer(options?.installed ?? comparisonAgainst(3));
  return renderChangesReveal({
    search: CHANGES_V3,
    installed: options?.installed ?? comparisonAgainst(3),
    draftNodes: options?.draftNodes ?? [changesStep("kept", "Kept")],
    catalog,
  });
}

type View = Awaited<ReturnType<typeof renderFocus>>;

/** Select a row in the change list, then open Focus from the header. */
function compare(view: View, row: string) {
  view.click(row);
  view.click("Compare fields");
  expect(view.aside().dataset.level).toBe("focus");
}

/** The column headings and the rows of the settings table, as text. */
function settingsTable(view: View) {
  const table = view.inReveal().getByRole("table", {
    name: "Settings of this step",
  });
  return {
    columns: within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent),
    rows: within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) =>
        [...row.querySelectorAll("th, td")].map((cell) => cell.textContent)
      ),
  };
}

beforeEach(() => {
  installAuthorizationGrantsForTests([
    WfGraphOperations.workflowCompareVersion.id,
    WfGraphOperations.workflowGetVersionHistory.id,
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetAuthorizationGrantsForTests();
});

describe("Changes Focus properties", () => {
  it("shows an added step's draft values alone, with readable names", async () => {
    const view = await renderFocus();
    compare(view, "Fresh Added");

    expect(
      view.aside().querySelector("[data-slot=reveal-path]")?.textContent
    ).toBe("Appointment reminders › Version 3 → proposed version 4 › Fresh");
    expect(
      view
        .inReveal()
        .getByText(
          "This step is new in the draft. It is not in version 3, so only the draft's values are shown."
        )
    ).toBeTruthy();
    const { columns, rows } = settingsTable(view);
    expect(columns).toEqual(["Setting", "Current draft"]);
    expect(rows).toEqual([
      ["Type", "Step"],
      ["Label", "Fresh"],
      ["Action", "Send email"],
      ["Subject", "Welcome"],
    ]);
    expect(view.inReveal().queryByText(/actionType|mail\/send/)).toBeNull();
  });

  it("shows a modified step's changed settings side by side, shortening a long value until expanded", async () => {
    const view = await renderFocus();
    compare(view, "Reminder Modified");

    const { columns, rows } = settingsTable(view);
    expect(columns).toEqual(["Setting", "Version 3", "Current draft"]);
    expect(rows[0]).toEqual(["Label", "Old reminder", "Reminder"]);
    expect(rows[1]?.[0]).toBe("Subject");
    const longValue = view
      .aside()
      .querySelector<HTMLElement>("[data-slot=comparison-long-value]");
    expect(longValue?.textContent?.endsWith("…")).toBe(true);
    expect(
      view
        .inReveal()
        .getByText(
          `Long value, ${LONG_SUBJECT.length.toLocaleString()} characters`
        )
    ).toBeTruthy();
    view.click("Show full value");
    expect(longValue?.textContent).toBe(LONG_SUBJECT);
    expect(
      view.inReveal().getByRole("button", { name: "Show less" })
    ).toBeTruthy();
  });

  it("shows a removed step's published values alone", async () => {
    const view = await renderFocus();
    compare(view, "Gone Removed");

    expect(settingsTable(view)).toEqual({
      columns: ["Setting", "Version 3"],
      rows: [
        ["Type", "Step"],
        ["Label", "Gone"],
      ],
    });
  });

  it("says when a step is unchanged and only its connections changed, and opens a connection from it", async () => {
    const view = await renderFocus();
    compare(view, "Fresh Added");
    await act(async () => {
      view.store.set(selectOnlyNodeAtom, "kept");
    });

    expect(view.aside().dataset.level).toBe("focus");
    expect(
      view
        .inReveal()
        .getByText(
          "This step's settings are the same in version 3 and the draft. Only its connections changed."
        )
    ).toBeTruthy();
    expect(view.inReveal().queryByRole("table")).toBeNull();
    view.click("Kept → Gone Removed");

    expect(view.store.get(activeSelectionAtom)).toEqual({
      nodeIds: [],
      edgeIds: ["kept-gone"],
    });
    const table = view.inReveal().getByRole("table", {
      name: "This connection",
    });
    expect(
      within(table)
        .getAllByRole("row")
        .map((row) =>
          [...row.querySelectorAll("th, td")].map((cell) => cell.textContent)
        )
    ).toEqual([
      ["Setting", "Version 3"],
      ["From", "Kept"],
      ["To", "Gone"],
    ]);
  });

  it("explains general setting names when the action is missing, and values the comparison lacks", async () => {
    const view = await renderFocus();
    compare(view, "Legacy Modified");

    expect(
      view.aside().querySelector("[data-state=missing-metadata]")?.textContent
    ).toBe(
      "The action this step uses is not available in this editor, so its settings show general names."
    );
    expect(settingsTable(view).rows).toEqual([
      ["Configuration value", "warm", "cool"],
    ]);
    expect(view.inReveal().queryByText("tone")).toBeNull();

    const withoutDraftNode = comparisonAgainst(3);
    const view2 = await renderFocus({
      installed: {
        ...withoutDraftNode,
        nodeChanges: [
          ...withoutDraftNode.nodeChanges,
          { nodeId: "kept", kind: "added" as const, fields: [] },
        ].filter((change) => change.nodeId !== "fresh"),
        draftGraph: createSerializedWorkflowGraph({
          nodes: [email("reminder", "Reminder", { subject: "" })],
          edges: [],
        }),
      },
    });
    await act(async () => {
      view2.store.set(selectOnlyNodeAtom, "kept");
    });
    view2.click("Compare fields");
    expect(
      view2.aside().querySelector("[data-state=unavailable]")?.textContent
    ).toBe(
      "The draft's values for this step are not available in this comparison."
    );
  });

  it("reports the validation issues the draft adds", async () => {
    const view = await renderFocus();
    compare(view, "Reminder Modified");

    expect(
      view.aside().querySelector("[data-state=validation]")?.textContent
    ).toBe("The draft adds 1 issue.");
    expect(
      view
        .inReveal()
        .getByText('Node "Reminder" is missing required field "Subject"')
    ).toBeTruthy();
  });
});

/** A serialized condition model with one rule: `field` equals `value`. */
function equalsFilter(field: string, value: string): string {
  return serializeConditionModel({
    version: 2,
    groupLogic: "and",
    groups: [
      {
        id: "group",
        logic: "and",
        conditions: [
          {
            id: "rule",
            field,
            fieldType: "string",
            operator: "equals",
            value,
          },
        ],
      },
    ],
  });
}

/** A Lifecycle Node whose rules hold `rules`. */
function lifecycleNode(rules: Record<string, unknown>): PersistedWorkflowNode {
  return {
    id: "lifecycle",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: {
      label: "Lifecycle",
      type: "lifecycle",
      config: {
        lifecycleRules: {
          startEvents: [BOOKED, CANCELED],
          cancelEvents: [],
          concurrency: "unlimited",
          ...rules,
        },
      },
    },
  };
}

const rulePath = (...segments: string[]) => [
  "data",
  "config",
  "lifecycleRules",
  ...segments,
];

/** A modified Lifecycle Node whose filters, connection, and Entity changed. */
function lifecycleComparison(): WorkflowComparisonPayload {
  const base = comparisonAgainst(3);
  return {
    ...base,
    baseGraph: createSerializedWorkflowGraph({
      nodes: [
        lifecycleNode({ trackedEntity: { type: "member", bindings: {} } }),
      ],
      edges: [],
    }),
    draftGraph: createSerializedWorkflowGraph({
      nodes: [
        lifecycleNode({ trackedEntity: { type: "patient", bindings: {} } }),
      ],
      edges: [],
    }),
    nodeChanges: [
      {
        nodeId: "lifecycle",
        kind: "modified",
        fields: [
          {
            path: rulePath("startFilters", BOOKED),
            kind: "modified",
            before: equalsFilter("appointment.channel", "video"),
            after: equalsFilter("appointment.channel", "phone"),
          },
          {
            path: rulePath("startFilters", CANCELED),
            kind: "modified",
            before: equalsFilter("appointment.channel", "video"),
            after: "{not a model",
          },
          {
            path: rulePath("connectionIds", BOOKED),
            kind: "modified",
            before: "conn_old",
            after: "conn_new",
          },
          {
            path: rulePath("trackedEntity", "type"),
            kind: "modified",
            before: "member",
            after: "patient",
          },
          {
            path: rulePath("entityEligibility", "checkpoints", "0"),
            kind: "modified",
            before: "before-execution",
            after: "before-node",
          },
          {
            path: rulePath("entityEligibility", "condition"),
            kind: "added",
            after: equalsFilter("status", "active"),
          },
          {
            path: rulePath("futureRule"),
            kind: "modified",
            before: "a",
            after: "b",
          },
        ],
      },
    ],
    edgeChanges: [],
  };
}

describe("Changes Focus Lifecycle Rules", () => {
  it("names Event-keyed rules by Event, reads filters as rules, and names connections from the cache", async () => {
    const view = await renderFocus({ installed: lifecycleComparison() });
    await act(async () => {
      view.queryClient.setQueryData(integrationsQueryOptions().queryKey, [
        { id: "conn_new", name: "Clinic Resend", type: "resend" },
      ] as never);
    });
    compare(view, "Lifecycle Modified");

    const { rows } = settingsTable(view);
    expect(rows.map((row) => row[0])).toEqual([
      "Start filter › Appointment booked",
      "Start filter › Appointment canceled",
      "Connection › Appointment booked",
      "Tracked Entity",
      "Eligibility checked",
      "Eligible when",
      "Lifecycle rule",
    ]);
    const [bookedFilter, canceledFilter, connection, entity, checkpoint] = rows;
    expect(bookedFilter?.[1]).toContain("video");
    expect(bookedFilter?.[2]).toContain("phone");
    expect(bookedFilter?.join(" ")).not.toContain("groups");
    expect(canceledFilter?.[2]).toBe("Filter changed");
    expect(connection).toEqual([
      "Connection › Appointment booked",
      "Connection changed",
      "Clinic Resend",
    ]);
    expect(entity).toEqual(["Tracked Entity", "member", "Patient"]);
    expect(checkpoint).toEqual([
      "Eligibility checked",
      "Before starting",
      "Before each step",
    ]);
    expect(rows[5]?.[2]).toContain("active");
    expect(
      view.aside().querySelector("[data-state=missing-metadata]")?.textContent
    ).toBe(
      "Some Lifecycle settings have no name in this editor, so they show general names."
    );
  });
});

describe("Changes Focus hidden values", () => {
  it("marks a masked or redacted value as hidden", async () => {
    const payload = comparisonAgainst(3);
    const view = await renderFocus({
      installed: {
        ...payload,
        nodeChanges: payload.nodeChanges.map((change) =>
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
      },
    });
    compare(view, "Reminder Modified");

    expect(settingsTable(view).rows).toEqual([
      ["Subject", "Hidden for security", "Hidden for security"],
    ]);
  });
});

describe("Changes Focus validation", () => {
  it("keeps an issue the same when the step is renamed", async () => {
    const payload = comparisonAgainst(3);
    const view = await renderFocus({
      installed: {
        ...payload,
        baseGraph: createSerializedWorkflowGraph({
          nodes: [email("reminder", "Old reminder", { subject: "" })],
          edges: [],
        }),
        nodeChanges: payload.nodeChanges.map((change) =>
          change.nodeId === "reminder"
            ? { ...change, fields: change.fields.slice(0, 1) }
            : change
        ),
      },
    });
    compare(view, "Reminder Modified");

    expect(
      view.aside().querySelector("[data-state=validation]")?.textContent
    ).toBe("Validation is the same in both versions.");
  });

  it("says validation is unknown for a step whose action is missing", async () => {
    const view = await renderFocus();
    compare(view, "Legacy Modified");

    expect(
      view.aside().querySelector("[data-state=validation]")?.textContent
    ).toBe(
      "Validation of the published step is unknown, because its action is not available in this editor. Validation of the draft's step is unknown, because its action is not available in this editor."
    );
  });
});

/**
 * Stub layout for the change list: the list shows its first 100 pixels, the
 * selected row sits at 400, and every other row at the top.
 */
function stubChangeListLayout() {
  const scrolled: HTMLElement[] = [];
  const box = (top: number, height: number) =>
    DOMRect.fromRect({ x: 0, y: top, width: 300, height });
  const measure = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      if (this.dataset.slot === "change-list") return box(0, 100);
      return this.getAttribute("aria-pressed") === "true"
        ? box(400, 30)
        : box(0, 30);
    });
  const scroll = vi
    .spyOn(HTMLElement.prototype, "scrollIntoView")
    .mockImplementation(function (this: HTMLElement) {
      scrolled.push(this);
    });
  return {
    scrolled,
    restore: () => {
      measure.mockRestore();
      scroll.mockRestore();
    },
  };
}

describe("Changes Focus navigation", () => {
  it("moves the canvas selection and Focus together with Previous and Next, and starts each object's values shortened", async () => {
    const view = await renderFocus();
    compare(view, "Reminder Modified");
    view.click("Show full value");

    view.click("Next change");
    expect(view.store.get(activeSelectionAtom).nodeIds).toEqual(["gone"]);
    expect(view.aside().dataset.level).toBe("focus");
    expect(settingsTable(view).columns).toEqual(["Setting", "Version 3"]);
    expect(view.inReveal().getByText("3 of 6")).toBeTruthy();

    view.click("Previous change");
    expect(view.store.get(activeSelectionAtom).nodeIds).toEqual(["reminder"]);
    expect(
      view.inReveal().getByRole("button", { name: "Show full value" })
    ).toBeTruthy();
  });

  it("returns from Focus to Browse with the list scroll, selection, camera, and focus on the row", async () => {
    const view = await renderFocus();
    view.click("Gone Removed");
    const scroller = view.list();
    if (!scroller) {
      throw new Error("the change list did not render");
    }
    scroller.scrollTop = 60;
    fireEvent.scroll(scroller);
    fireEvent(scroller, new Event("scrollend"));
    const camera = { centerX: 120, centerY: 40, zoom: 0.9 };
    view.store.set(recordWorkspaceCameraAtom, {
      address: workspaceAddressFromSearch(CHANGES_WORKFLOW_ID, CHANGES_V3),
      formFactor: "desktop",
      camera,
    });

    view.click("Compare fields");
    expect(view.list()).toBeNull();
    view.click("Back");

    expect(view.aside().dataset.level).toBe("browse");
    expect(view.store.get(activeSelectionAtom).nodeIds).toEqual(["gone"]);
    expect(view.store.get(activeWorkspaceCamerasAtom).desktop).toEqual(camera);
    await waitFor(() => expect(view.list()?.scrollTop).toBe(60));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        view.inReveal().getByRole("button", { name: "Gone Removed" })
      )
    );

    view.click("Compare fields");
    fireEvent.keyDown(
      view.inReveal().getByRole("heading", { name: /proposed version 4/ }),
      { key: "Escape" }
    );
    expect(view.aside().dataset.level).toBe("browse");
  });

  it("restores the Focus scroll after visiting Draft", async () => {
    const view = await renderFocus();
    compare(view, "Reminder Modified");
    const focusScroller = () =>
      view
        .aside()
        .querySelector<HTMLElement>('[data-slot="change-focus-content"]');
    const scroller = focusScroller();
    if (!scroller) {
      throw new Error("the Focus content did not render");
    }
    scroller.scrollTop = 180;
    fireEvent.scroll(scroller);
    fireEvent(scroller, new Event("scrollend"));

    await view.show({});
    await view.show(CHANGES_V3);

    expect(view.aside().dataset.level).toBe("focus");
    expect(view.store.get(activeSelectionAtom).nodeIds).toEqual(["reminder"]);
    await waitFor(() => expect(focusScroller()?.scrollTop).toBe(180));

    // Another object starts at the top, and that top is what Draft keeps.
    view.click("Next change");
    expect(focusScroller()?.scrollTop).toBe(0);
    await view.show({});
    await view.show(CHANGES_V3);
    expect(view.store.get(activeSelectionAtom).nodeIds).toEqual(["gone"]);
    await waitFor(() => expect(focusScroller()).not.toBeNull());
    expect(focusScroller()?.scrollTop).toBe(0);
  });

  it("returns from Focus to the change list when version history was open before Focus", async () => {
    const view = await renderFocus();
    view.click("Gone Removed");
    view.click("Version history");
    await waitFor(() =>
      expect(
        view.inReveal().getByRole("heading", { name: /history/i })
      ).toBeTruthy()
    );

    view.click("Compare fields");
    expect(view.aside().dataset.level).toBe("focus");
    view.click("Back");

    expect(view.aside().dataset.level).toBe("browse");
    expect(view.list()).not.toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        view.inReveal().getByRole("button", { name: "Gone Removed" })
      )
    );
    expect(view.store.get(changeRowFocusRequestAtom)).toBeNull();
  });

  it("drops a row focus request while Browse shows version history, so the list does not take focus later", async () => {
    const view = await renderFocus();
    view.click("Gone Removed");
    view.click("Version history");
    await act(async () => {
      view.store.set(
        changeRowFocusRequestAtom,
        workspaceAddressId(
          workspaceAddressFromSearch(CHANGES_WORKFLOW_ID, CHANGES_V3)
        )
      );
    });
    await waitFor(() =>
      expect(view.store.get(changeRowFocusRequestAtom)).toBeNull()
    );

    view.click("Back to changes");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        view.inReveal().getByRole("button", { name: "Version history" })
      )
    );
  });

  it("scrolls an off-screen row into view when Back follows Previous and Next", async () => {
    const steps = Array.from({ length: 12 }, (_, index) =>
      changesStep(`step_${index + 1}`, `Step ${index + 1}`)
    );
    const view = await renderFocus({
      installed: {
        ...comparisonAgainst(3),
        baseGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
        draftGraph: createSerializedWorkflowGraph({ nodes: steps, edges: [] }),
        nodeChanges: steps.map((step) => ({
          nodeId: step.id,
          kind: "added" as const,
          fields: [],
        })),
        edgeChanges: [],
      },
    });
    compare(view, "Step 1 Added");
    const layout = stubChangeListLayout();
    try {
      for (let step = 0; step < 10; step += 1) {
        view.click("Next change");
      }
      expect(view.store.get(activeSelectionAtom).nodeIds).toEqual(["step_11"]);
      view.click("Back");

      const row = view
        .inReveal()
        .getByRole("button", { name: "Step 11 Added" });
      await waitFor(() => expect(document.activeElement).toBe(row));
      expect(layout.scrolled).toEqual([row]);
    } finally {
      layout.restore();
    }
  });

  it("drops a comparison's property state while another comparison loads", async () => {
    const view = await renderFocus();
    compare(view, "Reminder Modified");
    view.click("Show full value");

    await view.show({ view: "changes", compare: "version_1" });
    await act(async () => {
      view.store.set(activeSelectionAtom, {
        nodeIds: ["reminder"],
        edgeIds: [],
      });
    });
    const epoch = view.store.set(
      beginWorkflowComparisonRequestAtom,
      CHANGES_WORKFLOW_ID,
      "version_1"
    );
    await waitFor(() =>
      expect(
        view
          .inReveal()
          .getByText("Comparing current draft with the published version")
      ).toBeTruthy()
    );
    expect(view.inReveal().queryByRole("table")).toBeNull();

    await act(async () => {
      view.store.set(installWorkflowComparisonAtom, {
        workflowId: CHANGES_WORKFLOW_ID,
        epoch,
        payload: comparisonAgainst(1),
      });
      view.store.set(settleWorkflowComparisonRequestAtom, {
        workflowId: CHANGES_WORKFLOW_ID,
        epoch,
      });
    });
    expect(view.aside().dataset.level).toBe("focus");
    expect(settingsTable(view).columns).toEqual([
      "Setting",
      "Version 1",
      "Current draft",
    ]);
    expect(
      view.inReveal().getByRole("button", { name: "Show full value" })
    ).toBeTruthy();
  });

  it("replaces the history entry when Next enters a Group, and Back restores the list where Focus was entered", async () => {
    const group: PersistedWorkflowNode = {
      id: "group_1",
      type: "group",
      position: { x: 0, y: 0 },
      data: { label: "Reminders", type: "group" },
    };
    const inner = (label: string): PersistedWorkflowNode => ({
      ...changesStep("inner", label),
      parentId: "group_1",
    });
    const labelChange = (before: string, after: string) => ({
      path: ["data", "label"],
      kind: "modified" as const,
      before,
      after,
    });
    const payload: WorkflowComparisonPayload = {
      ...comparisonAgainst(3),
      baseGraph: createSerializedWorkflowGraph({
        nodes: [group, inner("Old inner"), changesStep("kept", "Old kept")],
        edges: [],
      }),
      draftGraph: createSerializedWorkflowGraph({
        nodes: [group, inner("Inner"), changesStep("kept", "Kept")],
        edges: [],
      }),
      nodeChanges: [
        {
          nodeId: "kept",
          kind: "modified",
          fields: [labelChange("Old kept", "Kept")],
        },
        {
          nodeId: "inner",
          kind: "modified",
          fields: [labelChange("Old inner", "Inner")],
        },
      ],
      edgeChanges: [],
    };
    const view = await renderFocus({ installed: payload });
    view.click("Kept Modified");
    const scroller = view.list();
    if (!scroller) {
      throw new Error("the change list did not render");
    }
    scroller.scrollTop = 60;
    fireEvent.scroll(scroller);
    fireEvent(scroller, new Event("scrollend"));
    view.click("Compare fields");
    const entries = view.router.history.length;

    view.click("Next change");
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({
        ...CHANGES_V3,
        group: "group_1",
      })
    );
    expect(view.router.history.length).toBe(entries);
    await view.show({ ...CHANGES_V3, group: "group_1" });
    expect(view.aside().dataset.level).toBe("focus");
    view.click("Back");

    expect(view.aside().dataset.level).toBe("browse");
    await waitFor(() => expect(view.list()?.scrollTop).toBe(60));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        view.inReveal().getByRole("button", { name: "Inner Modified" })
      )
    );
  });

  it("enters a collapsed Group to select a changed step inside it", async () => {
    const group: PersistedWorkflowNode = {
      id: "group_1",
      type: "group",
      position: { x: 0, y: 0 },
      data: { label: "Reminders", type: "group" },
    };
    const inner = (label: string): PersistedWorkflowNode => ({
      ...changesStep("inner", label),
      parentId: "group_1",
    });
    const payload: WorkflowComparisonPayload = {
      ...comparisonAgainst(3),
      baseGraph: createSerializedWorkflowGraph({
        nodes: [group, inner("Old inner"), changesStep("kept", "Kept")],
        edges: [],
      }),
      draftGraph: createSerializedWorkflowGraph({
        nodes: [group, inner("Inner"), changesStep("kept", "Kept")],
        edges: [],
      }),
      nodeChanges: [
        {
          nodeId: "inner",
          kind: "modified",
          fields: [
            {
              path: ["data", "label"],
              kind: "modified",
              before: "Old inner",
              after: "Inner",
            },
          ],
        },
      ],
      edgeChanges: [],
    };
    const view = await renderFocus({ installed: payload });
    view.click("Inner Modified");

    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({
        ...CHANGES_V3,
        group: "group_1",
      })
    );
    await view.show({ ...CHANGES_V3, group: "group_1" });
    expect(view.store.get(activeSelectionAtom)).toEqual({
      nodeIds: ["inner"],
      edgeIds: [],
    });
    expect(view.aside().dataset.level).toBe("browse");
    view.click("Compare fields");
    expect(settingsTable(view).rows).toEqual([["Label", "Old inner", "Inner"]]);
  });

  it("enters a collapsed Group to select a changed connection between two of its members", async () => {
    const group: PersistedWorkflowNode = {
      id: "group_1",
      type: "group",
      position: { x: 0, y: 0 },
      data: { label: "Reminders", type: "group" },
    };
    const members = [
      { ...changesStep("first", "First"), parentId: "group_1" },
      { ...changesStep("second", "Second"), parentId: "group_1" },
    ];
    const inside = { id: "first-second", source: "first", target: "second" };
    const payload: WorkflowComparisonPayload = {
      ...comparisonAgainst(3),
      baseGraph: createSerializedWorkflowGraph({
        nodes: [group, ...members],
        edges: [],
      }),
      draftGraph: createSerializedWorkflowGraph({
        nodes: [group, ...members],
        edges: [inside],
      }),
      nodeChanges: [],
      edgeChanges: [{ edgeId: inside.id, kind: "added" }],
    };
    const view = await renderFocus({ installed: payload });
    view.click("First → Second Added");

    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({
        ...CHANGES_V3,
        group: "group_1",
      })
    );
    await view.show({ ...CHANGES_V3, group: "group_1" });
    expect(view.store.get(activeSelectionAtom)).toEqual({
      nodeIds: [],
      edgeIds: [inside.id],
    });
  });
});

describe("Changes Group organization", () => {
  const frame = (
    label: string,
    description: string
  ): PersistedWorkflowNode => ({
    id: "group",
    type: "group",
    position: { x: 0, y: 0 },
    data: { label, type: "group", description },
  });
  const inGroup = (node: PersistedWorkflowNode): PersistedWorkflowNode => ({
    ...node,
    parentId: "group",
  });
  const draftNodes = [
    frame("Follow-ups", "horizontal"),
    inGroup(changesStep("inner", "Inner")),
    inGroup(changesStep("moved", "Moved")),
  ];
  /**
   * Version 3 against a draft that renames the Group "Reminders" to
   * "Follow-ups", turns it horizontal, and moves the step "Moved" into it.
   */
  const organizationOnly: WorkflowComparisonPayload = {
    ...comparisonAgainst(3),
    baseGraph: createSerializedWorkflowGraph({
      nodes: [
        frame("Reminders", "vertical"),
        inGroup(changesStep("inner", "Inner")),
        changesStep("moved", "Moved"),
      ],
      edges: [],
    }),
    draftGraph: createSerializedWorkflowGraph({ nodes: draftNodes, edges: [] }),
    nodeChanges: [
      {
        nodeId: "group",
        kind: "modified",
        fields: [
          {
            path: ["data", "description"],
            kind: "modified",
            before: "vertical",
            after: "horizontal",
          },
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
  };

  function tableRows(view: View, name: string) {
    const table = view.inReveal().getByRole("table", { name });
    return within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) =>
        [...row.querySelectorAll("th, td")].map((cell) => cell.textContent)
      );
  }

  it("says an Organization-only comparison leaves execution behavior unchanged", async () => {
    const view = await renderFocus({ installed: organizationOnly, draftNodes });

    const summary = view.inReveal().getByRole("region", {
      name: "Comparison summary",
    });
    expect(summary.textContent).toContain(
      "Execution behavior is unchanged. Only how steps are organized in Groups differs."
    );
    expect(summary.textContent).toContain("Groups1 modified");
    expect(summary.textContent).toContain("Group membership1 step changed");
    expect(summary.textContent).not.toContain("Connections");
    expect(
      within(
        view.inReveal().getByRole("region", { name: "Changed Groups" })
      ).getByRole("button", { name: "Follow-ups Modified" })
    ).toBeTruthy();
    expect(
      within(
        view.inReveal().getByRole("region", { name: "Changed steps" })
      ).getByRole("button", { name: "Moved Group membership" })
    ).toBeTruthy();
  });

  it("shows a Group's settings in Group words and leads to its changed steps", async () => {
    const view = await renderFocus({ installed: organizationOnly, draftNodes });
    compare(view, "Follow-ups Modified");

    expect(tableRows(view, "Settings of this Group")).toEqual([
      ["Description", "vertical", "horizontal"],
      ["Label", "Reminders", "Follow-ups"],
    ]);
    expect(
      view.aside().querySelector("[data-state=missing-metadata]")
    ).toBeNull();
    expect(view.aside().textContent).toContain(
      "1 step inside it changed. Groups only organize steps, so execution behavior is unchanged."
    );

    view.click("Moved Group membership");
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({
        ...CHANGES_V3,
        group: "group",
      })
    );
    await view.show({ ...CHANGES_V3, group: "group" });
    expect(view.store.get(activeSelectionAtom)).toEqual({
      nodeIds: ["moved"],
      edgeIds: [],
    });
    expect(view.aside().dataset.level).toBe("focus");
    expect(tableRows(view, "Group membership of this step")).toEqual([
      ["Group", "Not in a Group", "Follow-ups"],
    ]);
    expect(
      view.inReveal().queryByRole("table", { name: "Settings of this step" })
    ).toBeNull();
    expect(view.aside().textContent).toContain(
      "It now sits in the Group Follow-ups. Execution behavior is unchanged for this step."
    );
  });

  it("keeps a new Group holding new steps from saying execution is unchanged", async () => {
    const addedDraft = [
      frame("Follow-ups", "vertical"),
      inGroup(changesStep("fresh", "Fresh")),
    ];
    const addedWithSteps: WorkflowComparisonPayload = {
      ...comparisonAgainst(3),
      baseGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
      draftGraph: createSerializedWorkflowGraph({
        nodes: addedDraft,
        edges: [],
      }),
      nodeChanges: [
        { nodeId: "group", kind: "added", fields: [] },
        { nodeId: "fresh", kind: "added", fields: [] },
      ],
      edgeChanges: [],
    };
    const view = await renderFocus({
      installed: addedWithSteps,
      draftNodes: addedDraft,
    });
    compare(view, "Follow-ups Added");

    expect(view.aside().textContent).toContain(
      "1 step inside it changed. The Group's own change does not affect execution."
    );
    expect(view.aside().textContent).not.toMatch(/behavior is unchanged/i);
  });

  it("keeps a renamed Group whose step changed settings from saying execution is unchanged", async () => {
    const mixed: WorkflowComparisonPayload = {
      ...organizationOnly,
      nodeChanges: [
        organizationOnly.nodeChanges[0]!,
        {
          nodeId: "moved",
          kind: "modified",
          fields: [
            { path: ["parentId"], kind: "added", after: "group" },
            {
              path: ["data", "config", "subject"],
              kind: "added",
              after: "Hello",
            },
          ],
        },
      ],
    };
    const view = await renderFocus({ installed: mixed, draftNodes });
    compare(view, "Follow-ups Modified");

    expect(view.aside().textContent).toContain(
      "1 step inside it changed. The Group's own change does not affect execution."
    );
    expect(view.aside().textContent).not.toMatch(/behavior is unchanged/i);
  });
});
