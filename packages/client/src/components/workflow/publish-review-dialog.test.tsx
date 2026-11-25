import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import {
  publicationReviewFromComparison,
  PublishReviewDialog,
  runsLeftOnOlderVersions,
} from "#src/components/workflow/publish-review-dialog";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import { orpcQuery } from "#src/lib/rpc-query";
import {
  beginWorkflowComparisonRequestAtom,
  comparisonSessionAtom,
  installWorkflowComparisonAtom,
} from "#src/lib/workflow-comparison-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type {
  WorkflowComparisonPayload,
  WorkflowVersionUsageItem,
} from "@wfgraph/shared/graph/publication-contracts";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowMode, WorkflowNode } from "@wfgraph/shared/graph/types";

const WORKFLOW_ID = "workflow_1";

const mailCatalog: ExtensionCatalog = {
  entities: [],
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
        { key: "body", label: "Body", type: "text" },
      ],
      outputFields: [],
    },
  ],
};

const comparison: WorkflowComparisonPayload = {
  baseVersion: {
    id: "version_7",
    version: 7,
    publishedAt: "2026-08-23T15:00:00.000Z",
    isCurrent: true,
  },
  proposedVersion: 8,
  baseGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
  draftGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
  hasChanges: true,
  nodeChanges: [
    { nodeId: "added", kind: "added", fields: [] },
    { nodeId: "modified", kind: "modified", fields: [] },
    { nodeId: "removed", kind: "removed", fields: [] },
  ],
  edgeChanges: [
    { edgeId: "new-connection", kind: "added" },
    { edgeId: "old-connection", kind: "removed" },
  ],
};

/**
 * The dialog inside the editor route of `WORKFLOW_ID`, over a cache holding
 * `usage` as that workflow's version usage when it is given.
 */
async function renderDialog(
  review: WorkflowComparisonPayload,
  options: {
    mode?: WorkflowMode;
    onConfirm?: () => void;
    onOpenChange?: (open: boolean) => void;
    usage?: WorkflowVersionUsageItem[];
  } = {}
) {
  const store = createStore();
  store.set(currentWorkflowIdAtom, WORKFLOW_ID);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (options.usage) {
    queryClient.setQueryData(
      orpcQuery.workflow.getVersionUsage.queryKey({
        input: { workflowId: WORKFLOW_ID },
      }),
      { items: options.usage }
    );
  }
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    validateSearch: (value: Record<string, unknown>) => value,
    component: () => (
      <PublishReviewDialog
        isPublishing={false}
        mode={options.mode ?? "test"}
        onConfirm={options.onConfirm ?? vi.fn()}
        onOpenChange={options.onOpenChange ?? vi.fn()}
        open
        review={publicationReviewFromComparison(review)}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({
      initialEntries: [`/workflows/${WORKFLOW_ID}`],
    }),
  });
  const view = render(
    <ExtensionCatalogProvider value={mailCatalog}>
      <QueryClientProvider client={queryClient}>
        <JotaiProvider store={store}>
          <OverlayProvider>
            <RouterProvider router={router} />
          </OverlayProvider>
        </JotaiProvider>
      </QueryClientProvider>
    </ExtensionCatalogProvider>
  );
  await view.findByRole("dialog");
  return Object.assign(view, { router, store });
}

afterEach(() => {
  resetAuthorizationGrantsForTests();
});

/** Each label and value row of one summary section, as text. */
function summaryRows(view: ReturnType<typeof render>, name: string) {
  const section = view.getByRole("region", { name });
  return [...section.querySelectorAll("dl > div")].map((row) => [
    row.querySelector("dt")?.textContent,
    row.querySelector("dd")?.textContent,
  ]);
}

const groupFrame = (label: string): WorkflowNode => ({
  id: "group",
  type: "group",
  position: { x: 0, y: 0 },
  data: { label, type: "group" },
});

const step = (id: string): WorkflowNode => ({
  id,
  type: "action",
  position: { x: 0, y: 0 },
  data: { label: id, type: "action" },
});

const inGroup = (node: WorkflowNode): WorkflowNode => ({
  ...node,
  parentId: "group",
});

/** Version 7 against a draft that renames a Group and moves "moved" into it. */
const organizationOnly: WorkflowComparisonPayload = {
  ...comparison,
  baseGraph: createSerializedWorkflowGraph({
    nodes: [groupFrame("Reminders"), inGroup(step("inner")), step("moved")],
    edges: [],
  }),
  draftGraph: createSerializedWorkflowGraph({
    nodes: [
      groupFrame("Follow-ups"),
      inGroup(step("inner")),
      inGroup(step("moved")),
    ],
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
};

describe("PublishReviewDialog", () => {
  it("says an Organization-only publish leaves execution behavior unchanged", async () => {
    const view = await renderDialog(organizationOnly);

    const behavior = view.getByRole("region", { name: "Behavior changes" });
    expect(behavior.textContent).toContain(
      "Execution behavior is unchanged. Only how steps are organized in Groups differs."
    );
    expect(behavior.querySelector("dl")).toBeNull();
    expect(summaryRows(view, "Organization changes")).toEqual([
      ["Groups", "1 modified"],
      ["Group membership", "1 step changed"],
    ]);
  });

  it("counts Behavior and Organization apart in a mixed publish", async () => {
    const view = await renderDialog({
      ...organizationOnly,
      nodeChanges: [
        ...organizationOnly.nodeChanges.slice(0, 1),
        {
          nodeId: "moved",
          kind: "modified",
          fields: [
            { path: ["parentId"], kind: "added", after: "group" },
            { path: ["data", "enabled"], kind: "added", after: false },
          ],
        },
      ],
      edgeChanges: [{ edgeId: "inner-moved", kind: "added" }],
    });

    expect(summaryRows(view, "Behavior changes")).toEqual([
      ["Steps", "1 modified"],
      ["Connections", "1 added"],
    ]);
    expect(summaryRows(view, "Organization changes")).toEqual([
      ["Groups", "1 modified"],
      ["Group membership", "1 step changed"],
    ]);
    expect(view.queryByText(/behavior is unchanged/i)).toBeNull();
  });

  it("presents deterministic structural facts and the Published mode consequence", async () => {
    const view = await renderDialog(comparison);

    expect(view.getByRole("dialog", { name: "Publish v8?" })).toBeTruthy();
    expect(view.getByText("Based on v7")).toBeTruthy();
    expect(view.getByText("Proposed v8")).toBeTruthy();
    expect(summaryRows(view, "Behavior changes")).toEqual([
      ["Steps", "1 added, 1 modified, 1 removed"],
      ["Connections", "1 added, 1 removed"],
    ]);
    expect(
      view.queryByRole("region", { name: "Organization changes" })
    ).toBeNull();
    const note = view.getByText(
      "Published mode is Test. v8 sends to test recipients until you switch to Live."
    );
    // The sentence stays muted in both modes, because a tinted box here would
    // rank one publish above the other. Amber marks Test on the dot alone, the
    // way the status strip's Published mode control marks it.
    expect(note.className).toContain("text-muted-foreground");
    expect(note.className).not.toContain("border-warning/30");
    expect(note.querySelector("svg")?.getAttribute("class")).toContain(
      "text-warning"
    );
  });

  // The Test note says the version is held back from real recipients. The Live
  // note says it reaches them at once. Both are one muted sentence.
  it("says a Live publish reaches real recipients at once", async () => {
    const view = await renderDialog(comparison, { mode: "live" });

    const note = view.getByText(
      "Published mode is Live. v8 sends to real recipients as soon as you publish."
    );
    expect(note.className).toContain("text-muted-foreground");
    expect(note.className).not.toContain("border-destructive/30");
    // Amber belongs to Test, so the Live dot stays in muted ink.
    expect(note.querySelector("svg")?.getAttribute("class")).not.toContain(
      "text-warning"
    );
    expect(view.queryByText(/Published mode is Test/)).toBeNull();
  });

  it("does not confirm publication when cancelled", async () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    const view = await renderDialog(comparison, {
      mode: "live",
      onConfirm,
      onOpenChange,
    });

    fireEvent.click(view.getByRole("button", { name: "Cancel" }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("lists each changed step by name with what changed", async () => {
    const mail = (id: string, label: string, body: string): WorkflowNode => ({
      id,
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label,
        type: "action",
        config: { actionType: "mail/send", subject: "Hello", body },
      },
    });
    const view = await renderDialog({
      ...comparison,
      baseGraph: createSerializedWorkflowGraph({
        nodes: [
          mail("reminder", "Send 24-hour reminder", "See you on Monday."),
          mail("billing", "Email the billing team", "Invoice"),
        ],
        edges: [],
      }),
      draftGraph: createSerializedWorkflowGraph({
        nodes: [
          mail("reminder", "Send 24-hour reminder", "See you tomorrow."),
          mail("welcome", "Send welcome", "Welcome"),
        ],
        edges: [],
      }),
      nodeChanges: [
        { nodeId: "welcome", kind: "added", fields: [] },
        {
          nodeId: "reminder",
          kind: "modified",
          fields: [
            {
              path: ["data", "config", "body"],
              kind: "modified",
              before: "See you on Monday.",
              after: "See you tomorrow.",
            },
          ],
        },
        { nodeId: "billing", kind: "removed", fields: [] },
      ],
    });

    const list = view.getByRole("region", { name: "Changed steps" });
    expect(
      [...list.querySelectorAll("li")].map((row) => row.textContent)
    ).toEqual([
      "AAdded: Send welcomeAdded",
      "MModified: Send 24-hour reminderBody",
      "DRemoved: Email the billing teamRemoved",
    ]);
  });

  it("lists no Group frame and names a step that only moved Groups", async () => {
    const view = await renderDialog(organizationOnly);

    const list = view.getByRole("region", { name: "Changed steps" });
    expect(
      [...list.querySelectorAll("li")].map((row) => row.textContent)
    ).toEqual(["MModified: movedGroup membership"]);
  });

  it("says how many active runs stay on older versions and opens version usage", async () => {
    installAuthorizationGrantsForTests([
      WfGraphOperations.workflowGetVersionUsage.id,
    ]);
    const onOpenChange = vi.fn();
    const usage = (
      version: number | null,
      activeRunCount: number
    ): WorkflowVersionUsageItem => {
      const fields = {
        id: `version_${version ?? "draft"}`,
        publishedAt: "2026-09-01T00:00:00.000Z",
        isCurrent: version === 7,
        activeRunCount,
        oldestActiveRunAt: null,
        actionIds: [],
        missingActionIds: [],
        catalogMatches: true,
      };
      return version === null
        ? { ...fields, kind: "draft_snapshot", version: null }
        : { ...fields, kind: "published", version };
    };
    const view = await renderDialog(comparison, {
      onOpenChange,
      usage: [usage(7, 2), usage(5, 1), usage(6, 0), usage(null, 4)],
    });

    expect(
      view.getByText("3 active runs stay on versions 5 and 7.", {
        exact: false,
      })
    ).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Show version usage" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    await vi.waitFor(() =>
      expect(view.router.state.location.search).toMatchObject({
        view: "changes",
      })
    );
    // The comparison the Changes route opens next shows version history.
    expect(view.store.get(comparisonSessionAtom)).toBeNull();
    const epoch = view.store.set(
      beginWorkflowComparisonRequestAtom,
      WORKFLOW_ID
    );
    view.store.set(installWorkflowComparisonAtom, {
      workflowId: WORKFLOW_ID,
      epoch,
      payload: comparison,
    });
    expect(view.store.get(comparisonSessionAtom)?.subview).toBe("history");
  });

  it("says nothing about runs without permission to read version usage, or with none active", async () => {
    const view = await renderDialog(comparison, {
      usage: [
        {
          id: "version_7",
          kind: "published",
          version: 7,
          publishedAt: "2026-09-01T00:00:00.000Z",
          isCurrent: true,
          activeRunCount: 3,
          oldestActiveRunAt: null,
          actionIds: [],
          missingActionIds: [],
          catalogMatches: true,
        },
      ],
    });

    expect(view.queryByText(/active run/)).toBeNull();
    expect(runsLeftOnOlderVersions([])).toBeNull();
    expect(
      runsLeftOnOlderVersions([
        {
          id: "version_7",
          kind: "published",
          version: 7,
          publishedAt: "2026-09-01T00:00:00.000Z",
          isCurrent: true,
          activeRunCount: 0,
          oldestActiveRunAt: null,
          actionIds: [],
          missingActionIds: [],
          catalogMatches: true,
        },
      ])
    ).toBeNull();
  });
});
