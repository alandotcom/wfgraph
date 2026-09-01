import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { createStore, Provider as JotaiProvider } from "jotai";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import {
  comparisonFields,
  formatComparisonValue,
} from "./comparison-properties";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { WorkflowChangesPanel } from "./workflow-changes-panel";
import {
  beginWorkflowComparisonRequestAtom,
  comparisonSessionAtom,
  installWorkflowComparisonAtom,
} from "#src/lib/workflow-comparison-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";

const catalog: ExtensionCatalog = {
  events: [],
  integrations: [],
  actions: [
    {
      id: "mail/send",
      label: "Send email",
      description: "",
      category: "Mail",
      configFields: [
        { key: "subject", label: "Subject", type: "text" },
        { key: "recipients", label: "Recipients", type: "text" },
      ],
      outputFields: [],
    },
  ],
};

function graph(label: string, subject: string) {
  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: "step_1",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          type: "action",
          label,
          enabled: true,
          config: { actionType: "mail/send", subject, recipients: ["a", "b"] },
        },
      },
    ],
    edges: [],
  });
}

const payload: WorkflowComparisonPayload = {
  baseVersion: {
    id: "version_1",
    version: 1,
    publishedAt: "2026-08-23T00:00:00.000Z",
    isCurrent: true,
  },
  proposedVersion: 2,
  baseGraph: graph("Published email", "Before"),
  draftGraph: graph("Current email", "After"),
  hasChanges: true,
  nodeChanges: [
    {
      nodeId: "step_1",
      kind: "modified",
      fields: [
        {
          path: ["data", "label"],
          kind: "modified",
          before: "Published email",
          after: "Current email",
        },
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
};

describe("comparison properties", () => {
  it("uses catalog labels for modified fields rather than machine paths", () => {
    const fields = comparisonFields(catalog, payload, payload.nodeChanges[0]!);

    expect(fields).toEqual([
      {
        key: 'field:["data","label"]:0',
        label: "Label",
        before: "Published email",
        after: "Current email",
      },
      {
        key: 'field:["data","config","subject"]:1',
        label: "Subject",
        before: "Before",
        after: "After",
      },
    ]);
    expect(fields.map((field) => field.label).join(" ")).not.toContain(
      "config.subject"
    );
  });

  it("shows only the current snapshot for added nodes and the published snapshot for removed nodes", () => {
    const added = comparisonFields(catalog, payload, {
      nodeId: "step_1",
      kind: "added",
      fields: [],
    });
    const removed = comparisonFields(catalog, payload, {
      nodeId: "step_1",
      kind: "removed",
      fields: [],
    });

    expect(added.find((field) => field.label === "Subject")).toEqual({
      key: "snapshot:config:subject",
      label: "Subject",
      after: "After",
    });
    expect(removed.find((field) => field.label === "Subject")).toEqual({
      key: "snapshot:config:subject",
      label: "Subject",
      after: "Before",
    });
  });

  it("summarizes structured values while preserving scalar values", () => {
    expect(formatComparisonValue(["a", "b"])).toBe("2 items");
    expect(formatComparisonValue({ recipient: "a" })).toBe("1 field");
    expect(formatComparisonValue(false)).toBe("Disabled");
    expect(formatComparisonValue("Subject")).toBe("Subject");
  });

  it("uses generic labels when a diff path or action id is unavailable", () => {
    const unavailable = {
      ...payload,
      draftGraph: createSerializedWorkflowGraph({
        nodes: [
          {
            id: "step_1",
            type: "action",
            position: { x: 0, y: 0 },
            data: {
              type: "action",
              label: "Current email",
              config: {
                actionType: "internal/private-action",
                secret_flag: true,
              },
            },
          },
        ],
        edges: [],
      }),
      nodeChanges: [
        {
          nodeId: "step_1",
          kind: "modified" as const,
          fields: [
            {
              path: ["internal", "secret_flag"],
              kind: "modified" as const,
              before: false,
              after: true,
            },
          ],
        },
      ],
    };

    const fields = comparisonFields(
      catalog,
      unavailable,
      unavailable.nodeChanges[0]!
    );
    const snapshotFields = comparisonFields(catalog, unavailable, {
      nodeId: "step_1",
      kind: "added",
      fields: [],
    });
    expect(fields.map((field) => field.label).join(" ")).toContain("Property");
    expect(fields.map((field) => field.label).join(" ")).not.toContain(
      "secret_flag"
    );
    expect(JSON.stringify(snapshotFields)).toContain("Unavailable action");
    expect(JSON.stringify(snapshotFields)).not.toContain("private-action");
  });

  it("gives duplicate generic labels distinct machine keys", () => {
    const fields = comparisonFields(catalog, payload, {
      nodeId: "step_1",
      kind: "modified",
      fields: [
        {
          path: ["internal", "first"],
          kind: "modified",
          before: false,
          after: true,
        },
        {
          path: ["internal", "second"],
          kind: "modified",
          before: false,
          after: true,
        },
      ],
    });

    expect(fields.map((field) => field.label)).toEqual([
      "Property",
      "Property",
    ]);
    expect(new Set(fields.map((field) => field.key)).size).toBe(2);
  });
});

/**
 * A router for a panel that never navigates.
 *
 * `useWorkflowWorkspaceNavigation` calls `useNavigate({ from:
 * "/workflows/$workflowId" })`, and that is the only router call in the panel's
 * subtree. `RouterContextProvider` is `RouterProvider` without `<Matches>`: it
 * puts the router in context and renders its children in the same pass. Nothing
 * resolves a match, so these cases stay synchronous. A case that reads route
 * state needs a real `RouterProvider`, and has to await its first match.
 */
const rootRoute = createRootRoute();
const router = createRouter({
  routeTree: rootRoute.addChildren([
    // The path the hook names. Nothing renders a match for it. It is here so
    // that `from` resolves rather than throwing.
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/workflows/$workflowId",
    }),
  ]),
  history: createMemoryHistory({ initialEntries: ["/workflows/workflow_1"] }),
});

function renderPanel(
  store: ReturnType<typeof createStore>,
  actions: Parameters<typeof WorkflowChangesPanel>[0]["actions"]
) {
  return render(
    <RouterContextProvider router={router}>
      <JotaiProvider store={store}>
        <OverlayProvider>
          <ExtensionCatalogProvider value={catalog}>
            <WorkflowChangesPanel actions={actions} />
          </ExtensionCatalogProvider>
        </OverlayProvider>
      </JotaiProvider>
    </RouterContextProvider>
  );
}

describe("WorkflowChangesPanel", () => {
  it("keeps the review header mounted during the initial comparison request", () => {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    store.set(workflowWorkspaceViewAtom, "changes");
    const actions = {
      isPending: true,
      compare: { isError: false },
      openComparison: async () => undefined,
    } as never;
    const view = renderPanel(store, actions);

    expect(view.getByRole("heading", { name: "Review changes" })).toBeTruthy();
    expect(
      view
        .getByRole("button", { name: "Refresh comparison" })
        .hasAttribute("disabled")
    ).toBe(true);
    expect(
      view
        .getByRole("button", { name: "Version history" })
        .hasAttribute("disabled")
    ).toBe(true);
    expect(view.getByRole("button", { name: "Exit comparison" })).toBeTruthy();
  });

  it("announces refresh progress inside the existing header slot", () => {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    store.set(workflowWorkspaceViewAtom, "changes");
    const epoch = store.set(beginWorkflowComparisonRequestAtom, "workflow_1");
    store.set(installWorkflowComparisonAtom, {
      workflowId: "workflow_1",
      epoch,
      payload,
    });
    const actions = {
      isPending: true,
      compare: { isError: false },
      openComparison: async () => undefined,
    } as never;
    const view = renderPanel(store, actions);

    const status = view.getByText("Refreshing comparison");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.closest("header")).not.toBeNull();
    expect(view.getByRole("button", { name: /Current email/ })).toBeTruthy();
  });

  it("uses pressed state for the selected change row", () => {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    store.set(workflowWorkspaceViewAtom, "changes");
    const epoch = store.set(beginWorkflowComparisonRequestAtom, "workflow_1");
    store.set(installWorkflowComparisonAtom, {
      workflowId: "workflow_1",
      epoch,
      payload,
    });
    const actions = {
      isPending: false,
      compare: { isError: false },
      openComparison: async () => undefined,
    } as never;
    const view = renderPanel(store, actions);

    const row = view.getByRole("button", { name: /Current email/ });
    expect(row.getAttribute("aria-pressed")).toBe("false");
    expect(view.queryByTestId("comparison-properties")).toBeNull();

    fireEvent.click(row);

    expect(store.get(workflowWorkspaceViewAtom)).toBe("changes");
    expect(store.get(comparisonSessionAtom)?.subview).toBe("properties");
    expect(view.getByRole("button", { name: "Back to changes" })).toBeTruthy();
  });
});
