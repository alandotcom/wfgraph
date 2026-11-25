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
  type WorkflowRouteSearch,
} from "#src/lib/workflow-navigation-state";
import {
  activeSelectionAtom,
  activeWorkspaceCamerasAtom,
  recordWorkspaceCameraAtom,
  setWorkspaceRevealLevelAtom,
  setWorkspaceSelectionAtom,
} from "#src/lib/workflow-workspace-navigation";
import { requestRevealPlacementAtom } from "./reveal-requests";
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

function renderList(options?: {
  installed?: WorkflowComparisonPayload;
  draftNodes?: readonly PersistedWorkflowNode[];
  beforeRender?: Parameters<typeof renderChangesReveal>[0]["beforeRender"];
}) {
  stubComparisonServer(options?.installed ?? comparisonAgainst(3));
  return renderChangesReveal({
    search: CHANGES_V3,
    installed: options?.installed ?? comparisonAgainst(3),
    draftNodes: options?.draftNodes ?? [changesStep("kept", "Kept")],
    catalog,
    beforeRender: options?.beforeRender,
  });
}

type View = Awaited<ReturnType<typeof renderList>>;
type Scope = ReturnType<typeof within>;

/** The change list row whose object is named `title`. */
function rowOf(view: View, title: string): HTMLElement {
  const name = view.inReveal().getByRole("button", { name: title });
  const row = name.closest<HTMLElement>('[data-slot="change-row"]');
  if (!row) {
    throw new Error(`${title} has no change list row`);
  }
  return row;
}

/** The control that opens and closes the row of `title`. */
function toggleOf(view: View, title: string): HTMLElement {
  const toggle = rowOf(view, title).querySelector<HTMLElement>(
    "button[aria-expanded]"
  );
  if (!toggle) {
    throw new Error(`${title}'s row does not open in place`);
  }
  return toggle;
}

/** The differences under the row of `title`, opening the row when it is closed. */
function differences(view: View, title: string): Scope {
  const toggle = toggleOf(view, title);
  if (toggle.getAttribute("aria-expanded") === "false") {
    fireEvent.click(toggle);
  }
  return within(within(rowOf(view, title)).getByRole("region"));
}

/** The column headings and the rows of a step's settings table, as text. */
function settingsTable(scope: Scope) {
  const table = scope.getByRole("table", { name: "Settings of this step" });
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

describe("Changes change list differences", () => {
  it("shows an added step's draft values alone, with readable names, in its row", async () => {
    const view = await renderList();

    expect(
      view.aside().querySelector("[data-slot=reveal-path]")?.textContent
    ).toBe("Appointment reminders › Version 3 → proposed version 4");
    expect(within(rowOf(view, "Fresh")).getByText("Added")).toBeTruthy();
    expect(toggleOf(view, "Fresh").getAttribute("aria-expanded")).toBe("false");
    const fresh = differences(view, "Fresh");
    expect(
      fresh.getByText(
        "This step is new in the draft. It is not in version 3, so only the draft's values are shown."
      )
    ).toBeTruthy();
    const { columns, rows } = settingsTable(fresh);
    expect(columns).toEqual(["Setting", "Current draft"]);
    expect(rows).toEqual([
      ["Type", "Step"],
      ["Label", "Fresh"],
      ["Action", "Send email"],
      ["Subject", "Welcome"],
    ]);
    expect(fresh.queryByText(/actionType|mail\/send/)).toBeNull();
  });

  it("shows a modified step's changed settings side by side, shortening a long value until expanded", async () => {
    const view = await renderList();
    expect(
      within(rowOf(view, "Reminder")).getByText("2 settings changed")
    ).toBeTruthy();
    const reminder = differences(view, "Reminder");

    const { columns, rows } = settingsTable(reminder);
    expect(columns).toEqual(["Setting", "Version 3", "Current draft"]);
    expect(rows[0]).toEqual(["Label", "Old reminder", "Reminder"]);
    expect(rows[1]?.[0]).toBe("Subject");
    const longValue = rowOf(view, "Reminder").querySelector<HTMLElement>(
      "[data-slot=comparison-long-value]"
    );
    expect(longValue?.textContent?.endsWith("…")).toBe(true);
    expect(
      reminder.getByText(
        `Long value, ${LONG_SUBJECT.length.toLocaleString()} characters`
      )
    ).toBeTruthy();
    fireEvent.click(reminder.getByRole("button", { name: "Show full value" }));
    expect(longValue?.textContent).toBe(LONG_SUBJECT);
    expect(reminder.getByRole("button", { name: "Show less" })).toBeTruthy();
  });

  it("marks the changed words of two long values, folds the rest, and draws template references as badges", async () => {
    const reference = "{{@kept:Kept.name}}";
    const opening = `Hi ${reference}, ${"this sentence stays the same. ".repeat(12)}`;
    const before = `${opening}Your visit is on Monday.`;
    const after = `${opening}Your visit is tomorrow.`;
    const withSubject = (subject: string) =>
      createSerializedWorkflowGraph({
        nodes: [
          changesStep("kept", "Kept"),
          email("reminder", "Reminder", { subject }),
        ],
        edges: [],
      });
    const view = await renderList({
      installed: {
        ...comparisonAgainst(3),
        baseGraph: withSubject(before),
        draftGraph: withSubject(after),
        nodeChanges: [
          {
            nodeId: "reminder",
            kind: "modified",
            fields: [
              {
                path: ["data", "config", "subject"],
                kind: "modified",
                before,
                after,
              },
            ],
          },
        ],
        edgeChanges: [],
      },
    });
    expect(
      within(rowOf(view, "Reminder")).getByText("Subject changed")
    ).toBeTruthy();
    const reminder = differences(view, "Reminder");

    const table = reminder.getByRole("table", {
      name: "Settings of this step",
    });
    const texts = (selector: string) =>
      [...table.querySelectorAll(selector)].map((item) => item.textContent);
    expect(texts("del")).toEqual(["on Monday"]);
    expect(texts("ins")).toEqual(["tomorrow"]);
    // The opening the two values share is folded in both columns, with one
    // control for the row.
    expect(
      within(table).getAllByRole("img", { name: "Unchanged text" })
    ).toHaveLength(2);
    expect(texts("[data-slot=template-reference]")).toEqual([]);

    fireEvent.click(reminder.getByRole("button", { name: "Show full value" }));
    expect(
      within(table).queryAllByRole("img", { name: "Unchanged text" })
    ).toEqual([]);
    expect(texts("[data-slot=template-reference]")).toEqual([
      "Kept.name",
      "Kept.name",
    ]);
    expect(table.textContent).not.toContain("{{@");
  });

  it("shows a removed step's published values alone", async () => {
    const view = await renderList();

    expect(settingsTable(differences(view, "Gone"))).toEqual({
      columns: ["Setting", "Version 3"],
      rows: [
        ["Type", "Step"],
        ["Label", "Gone"],
      ],
    });
  });

  it("keeps a connection row as one control, and lists a step's changed connections in its differences", async () => {
    const view = await renderList();
    const connection = view
      .inReveal()
      .getByRole("button", { name: "Kept → Gone Removed" });
    expect(
      connection
        .closest('[data-slot="change-row"]')
        ?.querySelector("[aria-expanded]")
    ).toBeNull();
    fireEvent.click(connection);
    expect(view.store.get(activeSelectionAtom)).toEqual({
      nodeIds: [],
      edgeIds: ["kept-gone"],
    });
    expect(connection.getAttribute("aria-pressed")).toBe("true");

    const fresh = differences(view, "Fresh");
    fireEvent.click(fresh.getByRole("button", { name: "Kept → Fresh Added" }));
    expect(view.store.get(activeSelectionAtom)).toEqual({
      nodeIds: [],
      edgeIds: ["kept-fresh"],
    });
  });

  it("explains general setting names when the action is missing, and values the comparison lacks", async () => {
    const view = await renderList();
    const legacy = differences(view, "Legacy");

    expect(
      rowOf(view, "Legacy").querySelector("[data-state=missing-metadata]")
        ?.textContent
    ).toBe(
      "The action this step uses is not available in this editor, so its settings show general names."
    );
    expect(settingsTable(legacy).rows).toEqual([
      ["Configuration value", "warm", "cool"],
    ]);
    expect(legacy.queryByText("tone")).toBeNull();

    const withoutDraftNode = comparisonAgainst(3);
    const view2 = await renderList({
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
    // Selecting the node on the canvas opens its row.
    await act(async () => {
      view2.store.set(selectOnlyNodeAtom, "kept");
    });
    await waitFor(() =>
      expect(
        view2.aside().querySelector("[data-state=unavailable]")?.textContent
      ).toBe(
        "The draft's values for this step are not available in this comparison."
      )
    );
  });

  it("reports the validation issues the draft adds", async () => {
    const view = await renderList();
    const reminder = differences(view, "Reminder");

    expect(
      rowOf(view, "Reminder").querySelector("[data-state=validation]")
        ?.textContent
    ).toBe("The draft adds 1 issue.");
    expect(
      reminder.getByText('Node "Reminder" is missing required field "Subject"')
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

describe("Changes change list Lifecycle Rules", () => {
  it("names Event-keyed rules by Event, reads filters as rules, and names connections from the cache", async () => {
    const view = await renderList({ installed: lifecycleComparison() });
    await act(async () => {
      view.queryClient.setQueryData(integrationsQueryOptions().queryKey, [
        { id: "conn_new", name: "Clinic Resend", type: "resend" },
      ] as never);
    });
    const lifecycle = differences(view, "Lifecycle");
    await waitFor(() =>
      expect(lifecycle.getAllByText("Clinic Resend").length).toBeGreaterThan(0)
    );

    const { rows } = settingsTable(lifecycle);
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

describe("Changes change list hidden values", () => {
  it("marks a masked or redacted value as hidden", async () => {
    const payload = comparisonAgainst(3);
    const view = await renderList({
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

    expect(settingsTable(differences(view, "Reminder")).rows).toEqual([
      ["Subject", "Hidden for security", "Hidden for security"],
    ]);
  });
});

describe("Changes change list validation", () => {
  it("keeps an issue the same when the step is renamed", async () => {
    const payload = comparisonAgainst(3);
    const view = await renderList({
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
    differences(view, "Reminder");

    expect(
      rowOf(view, "Reminder").querySelector("[data-state=validation]")
        ?.textContent
    ).toBe("Validation is the same in both versions.");
  });

  it("says validation is unknown for a step whose action is missing", async () => {
    const view = await renderList();
    differences(view, "Legacy");

    expect(
      rowOf(view, "Legacy").querySelector("[data-state=validation]")
        ?.textContent
    ).toBe(
      "Validation of the published step is unknown, because its action is not available in this editor. Validation of the draft's step is unknown, because its action is not available in this editor."
    );
  });
});

/**
 * Stub layout for the change list: the list shows its first 100 pixels, the
 * header of the selected row sits at 400, and every other element at the top.
 */
function stubChangeListLayout() {
  const box = (top: number, height: number) =>
    DOMRect.fromRect({ x: 0, y: top, width: 300, height });
  const measure = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      if (this.dataset.slot === "change-list") return box(0, 100);
      return this.querySelector(':scope > div [aria-pressed="true"]')
        ? box(400, 30)
        : box(0, 30);
    });
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
  return {
    scroll,
    restore: () => {
      measure.mockRestore();
      scroll.mockRestore();
    },
  };
}

/** Twelve added steps, more than the list opens by default. */
function twelveAddedSteps(): WorkflowComparisonPayload {
  const steps = Array.from({ length: 12 }, (_, index) =>
    changesStep(`step_${index + 1}`, `Step ${index + 1}`)
  );
  return {
    ...comparisonAgainst(3),
    baseGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
    draftGraph: createSerializedWorkflowGraph({ nodes: steps, edges: [] }),
    nodeChanges: steps.map((step) => ({
      nodeId: step.id,
      kind: "added" as const,
      fields: [],
    })),
    edgeChanges: [],
  };
}

describe("Changes change list navigation", () => {
  it("offers one level, opening modified rows by default, with no Compare fields, Back, or Previous and Next", async () => {
    const view = await renderList();

    expect(view.aside().dataset.level).toBe("browse");
    for (const name of [
      "Compare fields",
      "Return to summary",
      "Back",
      "Previous change",
      "Next change",
    ]) {
      expect(view.inReveal().queryByRole("button", { name })).toBeNull();
    }
    const expanded = (title: string) =>
      toggleOf(view, title).getAttribute("aria-expanded");
    expect(["Fresh", "Reminder", "Gone", "Legacy"].map(expanded)).toEqual([
      "false",
      "true",
      "false",
      "true",
    ]);
  });

  it("opens and closes a row from its chevron without selecting it or moving the camera", async () => {
    const view = await renderList();
    const camera = { centerX: 120, centerY: 40, zoom: 0.9 };
    view.store.set(recordWorkspaceCameraAtom, {
      address: workspaceAddressFromSearch(CHANGES_WORKFLOW_ID, CHANGES_V3),
      formFactor: "desktop",
      camera,
    });

    fireEvent.click(toggleOf(view, "Fresh"));
    expect(toggleOf(view, "Fresh").getAttribute("aria-expanded")).toBe("true");
    expect(within(rowOf(view, "Fresh")).getByRole("region")).toBeTruthy();
    fireEvent.click(toggleOf(view, "Reminder"));
    expect(toggleOf(view, "Reminder").getAttribute("aria-expanded")).toBe(
      "false"
    );
    expect(within(rowOf(view, "Reminder")).queryByRole("region")).toBeNull();

    expect(view.store.get(activeSelectionAtom)).toEqual({
      nodeIds: [],
      edgeIds: [],
    });
    expect(view.store.get(requestRevealPlacementAtom)).toBeNull();
    expect(view.store.get(activeWorkspaceCamerasAtom).desktop).toEqual(camera);
  });

  it("selects an object from its name and opens its row", async () => {
    const view = await renderList();
    const name = view.inReveal().getByRole("button", { name: "Gone" });
    fireEvent.click(name);

    expect(view.store.get(activeSelectionAtom).nodeIds).toEqual(["gone"]);
    expect(name.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() =>
      expect(toggleOf(view, "Gone").getAttribute("aria-expanded")).toBe("true")
    );
    // A second press on the name keeps the row open.
    fireEvent.click(name);
    expect(toggleOf(view, "Gone").getAttribute("aria-expanded")).toBe("true");
  });

  it("opens the row of an object selected on the canvas and scrolls its header to the top", async () => {
    const view = await renderList({ installed: twelveAddedSteps() });
    expect(toggleOf(view, "Step 11").getAttribute("aria-expanded")).toBe(
      "false"
    );
    const layout = stubChangeListLayout();
    try {
      await act(async () => {
        view.store.set(selectOnlyNodeAtom, "step_11");
      });
      await waitFor(() =>
        expect(toggleOf(view, "Step 11").getAttribute("aria-expanded")).toBe(
          "true"
        )
      );
      // Only the list scrolls, by the header's distance from the list's top.
      expect(view.list()?.scrollTop).toBe(400);
      expect(layout.scroll).not.toHaveBeenCalled();
    } finally {
      layout.restore();
    }
  });

  it("opens a row the reader closed again when its object is selected again after the selection cleared", async () => {
    const view = await renderList();
    const address = workspaceAddressFromSearch(CHANGES_WORKFLOW_ID, CHANGES_V3);
    const select = async (nodeIds: string[]) => {
      await act(async () => {
        view.store.set(setWorkspaceSelectionAtom, {
          address,
          selection: { nodeIds, edgeIds: [] },
        });
      });
    };

    await select(["gone"]);
    await waitFor(() =>
      expect(toggleOf(view, "Gone").getAttribute("aria-expanded")).toBe("true")
    );
    fireEvent.click(toggleOf(view, "Gone"));
    expect(toggleOf(view, "Gone").getAttribute("aria-expanded")).toBe("false");

    await select([]);
    expect(toggleOf(view, "Gone").getAttribute("aria-expanded")).toBe("false");
    await select(["gone"]);
    await waitFor(() =>
      expect(toggleOf(view, "Gone").getAttribute("aria-expanded")).toBe("true")
    );
  });

  it("keeps the rows the reader opened and closed through version history and a visit to Draft", async () => {
    const view = await renderList();
    fireEvent.click(toggleOf(view, "Fresh"));
    fireEvent.click(toggleOf(view, "Reminder"));
    const open = () =>
      ["Fresh", "Reminder", "Gone", "Legacy"].map((title) =>
        toggleOf(view, title).getAttribute("aria-expanded")
      );
    expect(open()).toEqual(["true", "false", "false", "true"]);

    view.click("Version history");
    await waitFor(() => expect(view.list()).toBeNull());
    view.click("Back to changes");
    await waitFor(() => expect(view.list()).not.toBeNull());
    expect(open()).toEqual(["true", "false", "false", "true"]);

    await view.show({});
    await view.show(CHANGES_V3);
    await waitFor(() => expect(view.list()).not.toBeNull());
    expect(open()).toEqual(["true", "false", "false", "true"]);
  });

  it("shows an address left at the Focus level as Browse, with its object's row open", async () => {
    const view = await renderList({
      beforeRender: (store) => {
        const address = workspaceAddressFromSearch(
          CHANGES_WORKFLOW_ID,
          CHANGES_V3
        );
        store.set(setWorkspaceSelectionAtom, {
          address,
          selection: { nodeIds: ["gone"], edgeIds: [] },
        });
        store.set(setWorkspaceRevealLevelAtom, { address, level: "focus" });
      },
    });

    expect(view.aside().dataset.level).toBe("browse");
    await waitFor(() =>
      expect(toggleOf(view, "Gone").getAttribute("aria-expanded")).toBe("true")
    );
    expect(
      settingsTable(within(within(rowOf(view, "Gone")).getByRole("region")))
        .columns
    ).toEqual(["Setting", "Version 3"]);
  });

  it("drops a comparison's expanded values while another comparison loads", async () => {
    const view = await renderList();
    fireEvent.click(
      differences(view, "Reminder").getByRole("button", {
        name: "Show full value",
      })
    );

    await view.show({ view: "changes", compare: "version_1" });
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
    const reminder = differences(view, "Reminder");
    expect(settingsTable(reminder).columns).toEqual([
      "Setting",
      "Version 1",
      "Current draft",
    ]);
    expect(
      reminder.getByRole("button", { name: "Show full value" })
    ).toBeTruthy();
  });

  it("carries the list's scroll into a Group when a step inside it is chosen, and opens that step's row", async () => {
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
        nodes: [group, inner("Inner"), changesStep("kept", "Kept")],
        edges: [],
      }),
      draftGraph: createSerializedWorkflowGraph({
        nodes: [group, inner("Inner"), changesStep("kept", "Kept")],
        edges: [],
      }),
      nodeChanges: [
        { nodeId: "kept", kind: "removed", fields: [] },
        { nodeId: "inner", kind: "added", fields: [] },
      ],
      edgeChanges: [],
    };
    const view = await renderList({ installed: payload });
    const scroller = view.list();
    if (!scroller) {
      throw new Error("the change list did not render");
    }
    scroller.scrollTop = 60;
    fireEvent.scroll(scroller);
    fireEvent(scroller, new Event("scrollend"));
    const entries = view.router.history.length;

    view.click("Inner");
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({
        ...CHANGES_V3,
        group: "group_1",
      })
    );
    expect(view.router.history.length).toBe(entries + 1);
    await view.show({ ...CHANGES_V3, group: "group_1" });

    expect(view.aside().dataset.level).toBe("browse");
    expect(view.store.get(activeSelectionAtom)).toEqual({
      nodeIds: ["inner"],
      edgeIds: [],
    });
    await waitFor(() => expect(view.list()?.scrollTop).toBe(60));
    await waitFor(() =>
      expect(toggleOf(view, "Inner").getAttribute("aria-expanded")).toBe("true")
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
    const view = await renderList({ installed: payload });
    view.click("Inner");

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
    expect(settingsTable(differences(view, "Inner")).rows).toEqual([
      ["Label", "Old inner", "Inner"],
    ]);
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
    const view = await renderList({ installed: payload });
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

  function tableRows(scope: Scope, name: string) {
    const table = scope.getByRole("table", { name });
    return within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) =>
        [...row.querySelectorAll("th, td")].map((cell) => cell.textContent)
      );
  }

  it("says an Organization-only comparison leaves execution behavior unchanged", async () => {
    const view = await renderList({ installed: organizationOnly, draftNodes });

    const summary = view.inReveal().getByRole("region", {
      name: "Comparison summary",
    });
    expect(summary.textContent).toContain(
      "Execution behavior is unchanged. Only how steps are organized in Groups differs."
    );
    expect(summary.textContent).toContain("Groups1 modified");
    expect(summary.textContent).toContain("Group membership1 step changed");
    expect(summary.textContent).not.toContain("Connections");
    const groups = view.inReveal().getByRole("region", {
      name: "Changed Groups",
    });
    expect(
      within(groups).getByRole("button", { name: "Follow-ups" })
    ).toBeTruthy();
    expect(within(groups).getByText("2 settings changed")).toBeTruthy();
    const steps = view.inReveal().getByRole("region", {
      name: "Changed steps",
    });
    expect(within(steps).getByRole("button", { name: "Moved" })).toBeTruthy();
    expect(within(steps).getByText("Moved into Follow-ups")).toBeTruthy();
  });

  it("shows a Group's settings in Group words and leads to its changed steps", async () => {
    const view = await renderList({ installed: organizationOnly, draftNodes });
    const group = differences(view, "Follow-ups");

    expect(tableRows(group, "Settings of this Group")).toEqual([
      ["Description", "vertical", "horizontal"],
      ["Label", "Reminders", "Follow-ups"],
    ]);
    expect(
      rowOf(view, "Follow-ups").querySelector("[data-state=missing-metadata]")
    ).toBeNull();
    expect(rowOf(view, "Follow-ups").textContent).toContain(
      "1 step inside it changed. Groups only organize steps, so execution behavior is unchanged."
    );

    fireEvent.click(
      group.getByRole("button", { name: "Moved Moved into Follow-ups" })
    );
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
    const moved = differences(view, "Moved");
    expect(tableRows(moved, "Group membership of this step")).toEqual([
      ["Group", "Not in a Group", "Follow-ups"],
    ]);
    expect(
      moved.queryByRole("table", { name: "Settings of this step" })
    ).toBeNull();
    expect(rowOf(view, "Moved").textContent).toContain(
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
    const view = await renderList({
      installed: addedWithSteps,
      draftNodes: addedDraft,
    });
    differences(view, "Follow-ups");

    const row = rowOf(view, "Follow-ups");
    expect(row.textContent).toContain(
      "1 step inside it changed. The Group's own change does not affect execution."
    );
    expect(row.textContent).not.toMatch(/behavior is unchanged/i);
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
    const view = await renderList({ installed: mixed, draftNodes });
    differences(view, "Follow-ups");

    const row = rowOf(view, "Follow-ups");
    expect(row.textContent).toContain(
      "1 step inside it changed. The Group's own change does not affect execution."
    );
    expect(row.textContent).not.toMatch(/behavior is unchanged/i);
  });
});
