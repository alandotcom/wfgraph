import { savedWorkflow } from "#src/lib/workflow-save-test-support";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import {
  OverlayProvider,
  useOverlay,
} from "#src/components/overlays/overlay-provider";
import { useWorkflowActions } from "#src/components/workflow/workflow-toolbar-handlers";
import { state } from "#src/components/workflow/workflow-toolbar-test-support";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import { orpcQuery } from "#src/lib/rpc-query";
import {
  extractRpcProcedurePath,
  parseRpcRequestInput,
  rpcJsonResponse,
  rpcUrl,
} from "#src/lib/rpc-fetch-test-support";
import { loadWorkflowGraphAtom } from "#src/lib/workflow-graph-store";
import {
  beginPublicationReviewAtom,
  installPublicationReviewAtom,
  publicationReviewAtom,
} from "#src/lib/workflow-publication-review-store";
import {
  openReviewPageAtom,
  requestReviewScrollAtom,
  reviewHighlightAtom,
} from "#src/lib/workflow-review-store";
import {
  currentWorkflowIdAtom,
  currentWorkflowModeAtom,
} from "#src/lib/workflow-save-store";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type {
  WorkflowComparisonPayload,
  WorkflowVersionUsageItem,
} from "@wfgraph/shared/graph/publication-contracts";
import type { WorkflowNode, WorkflowMode } from "@wfgraph/shared/graph/types";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { ReviewSheet, runsLeftOnOlderVersions } from "./review-sheet";

const WORKFLOW_ID = "workflow_1";

const catalog: ExtensionCatalog = {
  entities: [],
  events: [
    {
      name: "billing/payment.settled",
      label: "Payment settled",
      payloadFields: [],
    },
    {
      name: "billing/payment.refunded",
      label: "Payment refunded",
      payloadFields: [],
    },
    {
      name: "app/appointment.canceled",
      label: "Appointment canceled",
      payloadFields: [],
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
        { key: "subject", label: "Subject", type: "text" },
        { key: "body", label: "Body", type: "text" },
      ],
      outputFields: [],
    },
  ],
};

function mail(
  id: string,
  label: string,
  body: string,
  parentId?: string
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    ...omitUndefined({ parentId }),
    data: {
      label,
      type: "action",
      config: { actionType: "mail/send", subject: "Hello", body },
    },
  };
}

const lifecycle: WorkflowNode = {
  id: "lifecycle",
  type: "lifecycle",
  position: { x: 0, y: -100 },
  data: { label: "Appointment booked", type: "lifecycle" },
};

function group(label: string): WorkflowNode {
  return {
    id: "reminders",
    type: "group",
    position: { x: 0, y: 400 },
    data: { label, type: "group" },
  };
}

/**
 * Version 7 against a draft that rewords a reminder, adds an intake form,
 * removes the billing email, and renames the reminders Group.
 */
const comparison: WorkflowComparisonPayload = {
  baseVersion: {
    id: "version_7",
    version: 7,
    publishedAt: "2026-08-23T15:00:00.000Z",
    isCurrent: true,
  },
  proposedVersion: 8,
  baseGraph: createSerializedWorkflowGraph({
    nodes: [
      lifecycle,
      mail("receipt", "Send deposit receipt", "Thanks"),
      mail("billing", "Email the billing team", "Invoice"),
      group("Reminder sequence"),
      mail(
        "remind",
        "Send 24-hour reminder",
        "Hi, this is a reminder that your visit is on Monday.",
        "reminders"
      ),
    ],
    edges: [
      {
        id: "start",
        source: "lifecycle",
        target: "receipt",
        sourceHandle: "started",
      },
      { id: "receipt-billing", source: "receipt", target: "billing" },
    ],
  }),
  draftGraph: createSerializedWorkflowGraph({
    nodes: [
      lifecycle,
      mail("receipt", "Send deposit receipt", "Thanks"),
      mail("intake", "Send intake form", "Please complete the intake form."),
      group("Pre-visit reminders"),
      mail(
        "remind",
        "Send 24-hour reminder",
        "Hi, your visit is tomorrow.",
        "reminders"
      ),
    ],
    edges: [
      {
        id: "start",
        source: "lifecycle",
        target: "receipt",
        sourceHandle: "started",
      },
      { id: "receipt-intake", source: "receipt", target: "intake" },
    ],
  }),
  hasChanges: true,
  nodeChanges: [
    {
      nodeId: "reminders",
      kind: "modified",
      fields: [
        {
          path: ["data", "label"],
          kind: "modified",
          before: "Reminder sequence",
          after: "Pre-visit reminders",
        },
      ],
    },
    {
      nodeId: "remind",
      kind: "modified",
      fields: [
        {
          path: ["data", "config", "body"],
          kind: "modified",
          before: "Hi, this is a reminder that your visit is on Monday.",
          after: "Hi, your visit is tomorrow.",
        },
      ],
    },
    { nodeId: "intake", kind: "added", fields: [] },
    { nodeId: "billing", kind: "removed", fields: [] },
  ],
  edgeChanges: [
    { edgeId: "receipt-intake", kind: "added" },
    { edgeId: "receipt-billing", kind: "removed" },
  ],
};

const requests: Array<{ path: string; input: Record<string, unknown> }> = [];

/** Answers the comparison of a past version, and records every request. */
function stubServer(version: WorkflowComparisonPayload) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = extractRpcProcedurePath(rpcUrl(url));
      const input = await parseRpcRequestInput(init);
      requests.push({ path, input });
      if (path === "workflow/compareVersion") {
        return rpcJsonResponse(version);
      }
      if (path === "workflow/getVersionHistory") {
        return rpcJsonResponse({
          items: [
            {
              id: "version_7",
              version: 7,
              publishedAt: "2026-08-23T15:00:00.000Z",
              isCurrent: true,
            },
            {
              id: "version_6",
              version: 6,
              publishedAt: "2026-08-20T15:00:00.000Z",
              isCurrent: false,
            },
          ],
          nextCursor: null,
        });
      }
      return new Promise<Response>(() => undefined);
    })
  );
}

/** The sheet over the draft's review of `payload`, in `mode`. */
async function renderSheet(
  options: {
    payload?: WorkflowComparisonPayload | null;
    mode?: WorkflowMode;
    usage?: WorkflowVersionUsageItem[];
    /** Also mount the toolbar's document-level shortcuts, as the editor does. */
    withToolbar?: boolean;
    /** Also mount an outline whose one row takes Tab, as the editor does. */
    withOutline?: boolean;
  } = {}
) {
  const store = createStore();
  store.set(loadWorkflowGraphAtom, { nodes: [], edges: [] });
  store.set(currentWorkflowIdAtom, WORKFLOW_ID);
  store.set(currentWorkflowModeAtom, options.mode ?? "test");
  const payload = options.payload === undefined ? comparison : options.payload;
  if (payload) {
    const epoch = store.set(beginPublicationReviewAtom, WORKFLOW_ID);
    store.set(installPublicationReviewAtom, {
      workflowId: WORKFLOW_ID,
      epoch: epoch ?? 0,
      pending: false,
      graph: payload.draftGraph,
      expectedDraftRevision: 1,
      expectedPublishedVersionId: payload.baseVersion?.id ?? null,
      payload,
    });
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
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
      <>
        <ReviewSheet />
        {options.withToolbar ? <ToolbarShortcuts /> : null}
        {options.withOutline ? (
          <div data-slot="outline-body">
            <div aria-label="Outline" role="tree">
              <div aria-selected={false} role="treeitem" tabIndex={0}>
                Lifecycle
              </div>
            </div>
          </div>
        ) : null}
      </>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({
      initialEntries: [`/workflows/${WORKFLOW_ID}`],
    }),
  });
  const view = render(
    <ExtensionCatalogProvider value={catalog}>
      <QueryClientProvider client={queryClient}>
        <JotaiProvider store={store}>
          <ReactFlowProvider>
            <OverlayProvider>
              <RouterProvider router={router} />
            </OverlayProvider>
          </ReactFlowProvider>
        </JotaiProvider>
      </QueryClientProvider>
    </ExtensionCatalogProvider>
  );
  await router.load();
  return Object.assign(view, { store, router });
}

/** The toolbar's shortcuts, and how many dialogs they have opened. */
function ToolbarShortcuts() {
  useWorkflowActions(state());
  const { stack } = useOverlay();
  return <output aria-label="overlay count">{stack.length}</output>;
}

const sheet = (view: ReturnType<typeof render>) =>
  view.container.querySelector<HTMLElement>('[data-slot="review-sheet"]');

beforeEach(() => {
  requests.length = 0;
  stubServer(comparison);
  installAuthorizationGrantsForTests([
    WfGraphOperations.workflowPublish.id,
    WfGraphOperations.workflowGetVersionUsage.id,
    WfGraphOperations.workflowGetVersionHistory.id,
    WfGraphOperations.workflowCompareVersion.id,
    WfGraphOperations.workflowRestoreVersion.id,
    WfGraphOperations.workflowUpdate.id,
  ]);
});

afterEach(() => {
  resetAuthorizationGrantsForTests();
  vi.unstubAllGlobals();
});

/** A Lifecycle Node that starts on `startEvent` and stops on a cancellation. */
function startingOn(startEvent: string): WorkflowNode {
  return {
    ...lifecycle,
    data: {
      ...lifecycle.data,
      config: {
        lifecycleRules: {
          startEvents: [startEvent],
          cancelEvents: ["app/appointment.canceled"],
          concurrency: "unlimited",
          allowManualStart: true,
        },
      },
    },
  };
}

describe("ReviewSheet", () => {
  it("stays closed while no review is open", async () => {
    const view = await renderSheet({ payload: null });
    expect(sheet(view)).toBeNull();
  });

  it("titles the sheet with the decision and counts the edits in one line", async () => {
    const view = await renderSheet();

    const title = await view.findByRole("heading", { name: "Publish v8" });
    expect(document.activeElement).toBe(title);
    expect(
      view.container.querySelector('[data-slot="review-count"]')?.textContent
    ).toBe("3 edits change what runs. 1 does not.");
    // The internal taxonomy is gone from the reader's words.
    expect(sheet(view)?.textContent).not.toMatch(
      /Behavior|Organization|comparison|proposed version/
    );
  });

  it("lists each edit in path order with its marker, what changed, and its strip", async () => {
    const view = await renderSheet();
    await view.findByRole("heading", { name: "Publish v8" });

    const edits = within(view.getByRole("list", { name: "Edits" }))
      .getAllByRole("listitem")
      .map((item) => ({
        name: item.querySelector("h3")?.textContent,
        strip: item.querySelector('[data-slot="review-strip"]')?.textContent,
        struck: item.querySelector('[data-slot="review-strip"] del')
          ?.textContent,
      }));
    expect(edits).toEqual([
      {
        name: "Added: Send intake form",
        strip: "Send deposit receipt → Send intake form → path ends",
        struck: undefined,
      },
      {
        name: "Removed: Email the billing team",
        strip: "Send deposit receipt → Email the billing team → path ends",
        // A removed step's own name is struck through in its strip.
        struck: "Email the billing team",
      },
      {
        name: "Modified: Send 24-hour reminder",
        strip: "In Pre-visit reminders: Send 24-hour reminder → path ends",
        struck: undefined,
      },
    ]);
    expect(view.getByText("Body changed")).toBeTruthy();
    expect(view.getByText("New step")).toBeTruthy();
    expect(view.getByText("Removed")).toBeTruthy();
  });

  it("shows a changed text setting as one flow with removed and added words marked", async () => {
    const view = await renderSheet();
    await view.findByRole("heading", { name: "Publish v8" });

    const body = view.getByRole("region", { name: "Body" });
    const diff = body.querySelector('[data-slot="comparison-diff"]');
    expect(diff?.textContent).toBe(
      "Hi, this is a reminder that your visit is on Monday. tomorrow."
    );
    expect(
      [...(diff?.querySelectorAll("del") ?? [])].map((del) => del.textContent)
    ).toEqual(["this is a reminder that ", "on Monday."]);
    expect(
      [...(diff?.querySelectorAll("ins") ?? [])].map((ins) => ins.textContent)
    ).toEqual(["tomorrow."]);
  });

  it("shows a new step as what it does and its main content, with every setting one press away", async () => {
    const view = await renderSheet();
    await view.findByRole("heading", { name: "Publish v8" });

    const added = view.getByRole("region", { name: "What it does" });
    expect(added.textContent).toContain("Send email");
    expect(added.textContent).toContain("Please complete the intake form.");
    expect(view.queryByRole("list", { name: "All settings" })).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Show all settings" }));
    expect(view.getByLabelText("All settings").textContent).toContain(
      "Subject"
    );
  });

  it("collects the Group rename under Does not change what runs, collapsed", async () => {
    const view = await renderSheet();
    await view.findByRole("heading", { name: "Publish v8" });

    const trigger = view.getByRole("button", {
      name: /Does not change what runs/,
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(
      await view.findByText(
        'Group "Reminder sequence" renamed to "Pre-visit reminders"'
      )
    ).toBeTruthy();
  });

  it("opens the changes that do not change what runs when they are all there is", async () => {
    const groupOnly: WorkflowComparisonPayload = {
      ...comparison,
      draftGraph: comparison.baseGraph,
      nodeChanges: comparison.nodeChanges.filter(
        (change) => change.nodeId === "reminders"
      ),
      edgeChanges: [],
    };
    const view = await renderSheet({ payload: groupOnly });
    await view.findByRole("heading", { name: "Publish v8" });

    expect(
      view.container.querySelector('[data-slot="review-count"]')?.textContent
    ).toBe("No edit changes what runs. 1 does not.");
    expect(view.queryByRole("list", { name: "Edits" })).toBeNull();
    expect(
      view
        .getByRole("button", { name: /Does not change what runs/ })
        .getAttribute("aria-expanded")
    ).toBe("true");
  });

  it("states the Test consequence and the runs left on older versions", async () => {
    const view = await renderSheet({
      usage: [
        {
          kind: "published",
          version: 6,
          id: "version_6",
          publishedAt: "2026-08-20T15:00:00.000Z",
          isCurrent: false,
          activeRunCount: 1,
          oldestActiveRunAt: null,
          actionIds: [],
          missingActionIds: [],
          catalogMatches: true,
        },
      ],
    });
    await view.findByRole("heading", { name: "Publish v8" });

    const line = view.getByText(
      /^Test\. New runs use v8 and reach test recipients\./
    );
    expect(line.textContent).toBe(
      "Test. New runs use v8 and reach test recipients. 1 active run stays on v6."
    );
    // Amber marks Test on the dot alone, as the status strip's control does.
    expect(
      line.parentElement?.querySelector("svg")?.getAttribute("class")
    ).toContain("text-warning");
  });

  it("offers the version history's migration beside runs left on a version older than the current one", async () => {
    installAuthorizationGrantsForTests([
      WfGraphOperations.workflowPublish.id,
      WfGraphOperations.workflowGetVersionUsage.id,
      WfGraphOperations.workflowMigrateExecutions.id,
      WfGraphOperations.workflowPreviewMigration.id,
    ]);
    const published = (
      version: number,
      isCurrent: boolean,
      activeRunCount: number
    ): WorkflowVersionUsageItem => ({
      kind: "published",
      version,
      id: `version_${version}`,
      publishedAt: "2026-08-20T15:00:00.000Z",
      isCurrent,
      activeRunCount,
      oldestActiveRunAt: null,
      actionIds: [],
      missingActionIds: [],
      catalogMatches: true,
    });
    const view = await renderSheet({
      usage: [published(7, true, 0), published(6, false, 1)],
    });
    await view.findByRole("heading", { name: "Publish v8" });

    // The migration moves parked runs onto the current publication, v7.
    fireEvent.click(view.getByRole("button", { name: "Move to v7" }));
    expect(
      await view.findByRole("dialog", { name: "Migrate active runs" })
    ).toBeTruthy();
    view.unmount();

    // Runs already on the current version can move only once v8 is
    // published, so the line offers nothing.
    const onCurrent = await renderSheet({ usage: [published(7, true, 2)] });
    await onCurrent.findByRole("heading", { name: "Publish v8" });
    expect(onCurrent.getByText(/2 active runs stay on v7\./)).toBeTruthy();
    expect(onCurrent.queryByRole("button", { name: /^Move to/ })).toBeNull();
  });

  it("states the Live consequence with the dot in muted ink", async () => {
    const view = await renderSheet({ mode: "live" });
    await view.findByRole("heading", { name: "Publish v8" });

    const line = view.getByText(
      "Live. New runs use v8 and reach real recipients."
    );
    expect(
      line.parentElement?.querySelector("svg")?.getAttribute("class")
    ).not.toContain("text-warning");
  });

  it("publishes the reviewed snapshot from the footer and from Cmd+Enter", async () => {
    stubServer(comparison);
    const view = await renderSheet();
    await view.findByRole("heading", { name: "Publish v8" });

    fireEvent.keyDown(view.getByRole("button", { name: "Keep editing" }), {
      key: "Enter",
      ctrlKey: true,
    });
    await waitFor(() =>
      expect(requests.map((request) => request.path)).toContain(
        "workflow/publish"
      )
    );
    expect(
      requests.find((request) => request.path === "workflow/publish")?.input
    ).toMatchObject({
      workflowId: WORKFLOW_ID,
      expectedDraftRevision: 1,
      expectedPublishedVersionId: "version_7",
    });
  });

  // A publish disables the Publish button that opened the sheet, so focus
  // cannot go back to it and would fall to the page.
  it("puts focus on the outline when a publish closes the sheet", async () => {
    stubServer(comparison);
    const unanswered = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) =>
        extractRpcProcedurePath(rpcUrl(input)) === "workflow/publish"
          ? rpcJsonResponse({
              ...savedWorkflow(WORKFLOW_ID),
              draftRevision: 2,
              publishedVersionId: "version_8",
              publishedVersion: 8,
              publishedAt: "2026-08-23T16:00:00.000Z",
              warnings: [],
            })
          : unanswered(input, init)
    );
    const view = await renderSheet({ withOutline: true });
    await view.findByRole("heading", { name: "Publish v8" });

    fireEvent.keyDown(view.getByRole("button", { name: "Keep editing" }), {
      key: "Enter",
      ctrlKey: true,
    });

    await waitFor(() => expect(sheet(view)).toBeNull());
    expect(document.activeElement).toBe(
      view.getByRole("treeitem", { name: "Lifecycle" })
    );
  });

  // The toolbar's run shortcut listens on the document in the capture phase,
  // so it would take the key before the sheet saw it.
  it("publishes on Cmd+Enter from the sheet's title and opens no Run draft dialog", async () => {
    const view = await renderSheet({ withToolbar: true });
    const title = await view.findByRole("heading", { name: "Publish v8" });
    await waitFor(() => expect(document.activeElement).toBe(title));

    fireEvent.keyDown(title, { key: "Enter", metaKey: true });

    await waitFor(() =>
      expect(requests.map((request) => request.path)).toContain(
        "workflow/publish"
      )
    );
    expect(view.getByLabelText("overlay count").textContent).toBe("0");
  });

  // Pressing a card on the canvas leaves focus on the page, outside the
  // sheet that listens for Escape.
  it("moves focus to the pressed card's edit, where Escape keeps editing", async () => {
    const view = await renderSheet();
    const title = await view.findByRole("heading", { name: "Publish v8" });
    await waitFor(() => expect(document.activeElement).toBe(title));
    title.blur();

    act(() => view.store.set(requestReviewScrollAtom, "remind"));

    const entry = view
      .getAllByRole("listitem")
      .find((item) => item.dataset.editNode === "remind");
    const editTitle = entry?.querySelector('[data-slot="review-edit-title"]');
    await waitFor(() => expect(document.activeElement).toBe(editTitle));
    expect(view.store.get(reviewHighlightAtom)).toBe("remind");

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(view.store.get(publicationReviewAtom)).toBeNull();
  });

  it("moves focus to the sheet's title when the pressed card has no edit", async () => {
    const view = await renderSheet();
    const title = await view.findByRole("heading", { name: "Publish v8" });
    await waitFor(() => expect(document.activeElement).toBe(title));
    title.blur();

    act(() => view.store.set(requestReviewScrollAtom, "unchanged-step"));

    await waitFor(() => expect(document.activeElement).toBe(title));
  });

  it("keeps editing by closing the review", async () => {
    const view = await renderSheet();
    await view.findByRole("heading", { name: "Publish v8" });

    fireEvent.click(view.getByRole("button", { name: "Keep editing" }));

    expect(view.store.get(publicationReviewAtom)).toBeNull();
    await waitFor(() => expect(sheet(view)).toBeNull());
  });

  it("points at an edit's card while the pointer rests on it", async () => {
    const view = await renderSheet();
    await view.findByRole("heading", { name: "Publish v8" });
    const entry = view
      .getAllByRole("listitem")
      .find((item) => item.dataset.editNode === "remind");

    fireEvent.pointerEnter(entry!);
    expect(view.store.get(reviewHighlightAtom)).toBe("remind");
    fireEvent.pointerLeave(entry!);
    expect(view.store.get(reviewHighlightAtom)).toBeNull();
  });

  it("opens what a past version changed from version history, with Restore where Publish sits", async () => {
    const previous: WorkflowComparisonPayload = {
      ...comparison,
      baseVersion: {
        id: "version_5",
        version: 5,
        publishedAt: "2026-08-10T15:00:00.000Z",
        isCurrent: false,
      },
      proposedVersion: 6,
    };
    stubServer(previous);
    const view = await renderSheet();
    await view.findByRole("heading", { name: "Publish v8" });

    fireEvent.click(view.getByRole("button", { name: "Version history" }));
    await view.findByRole("heading", { name: "Version history" });
    fireEvent.click(await view.findByRole("button", { name: /^v6/ }));

    await view.findByRole("heading", { name: "What v6 changed" });
    await waitFor(() =>
      expect(
        view.container.querySelector('[data-slot="review-count"]')?.textContent
      ).toBe("3 edits change what runs. 1 does not.")
    );
    expect(
      requests.find((request) => request.path === "workflow/compareVersion")
        ?.input
    ).toEqual({ workflowId: WORKFLOW_ID, versionId: "version_6" });
    expect(
      view.getByRole("button", { name: "Restore v6 as draft" })
    ).toBeTruthy();
    expect(view.queryByRole("button", { name: /^Publish v/ })).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Restore v6 as draft" }));
    expect(
      await view.findByRole("heading", { name: "Restore v6 as draft?" })
    ).toBeTruthy();
  });

  it("offers no Restore for the version published now, and Back returns to the list", async () => {
    stubServer(comparison);
    const view = await renderSheet({ payload: null });
    act(() =>
      view.store.set(openReviewPageAtom, {
        workflowId: WORKFLOW_ID,
        page: { kind: "history" },
      })
    );
    await view.findByRole("heading", { name: "Version history" });
    expect(view.queryByRole("button", { name: "Back" })).toBeNull();

    fireEvent.click(await view.findByRole("button", { name: /^v7/ }));
    await view.findByRole("heading", { name: "What v7 changed" });
    expect(view.getByText("v7 is the current version.")).toBeTruthy();
    expect(view.queryByRole("button", { name: /^Restore/ })).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Back" }));
    await view.findByRole("heading", { name: "Version history" });
  });
});

describe("runsLeftOnOlderVersions", () => {
  const item = (
    version: number | null,
    activeRunCount: number
  ): WorkflowVersionUsageItem =>
    version === null
      ? {
          kind: "draft_snapshot",
          version: null,
          id: "snapshot",
          publishedAt: "2026-08-20T15:00:00.000Z",
          isCurrent: false,
          activeRunCount,
          oldestActiveRunAt: null,
          actionIds: [],
          missingActionIds: [],
          catalogMatches: true,
        }
      : {
          kind: "published",
          version,
          id: `version_${version}`,
          publishedAt: "2026-08-20T15:00:00.000Z",
          isCurrent: false,
          activeRunCount,
          oldestActiveRunAt: null,
          actionIds: [],
          missingActionIds: [],
          catalogMatches: true,
        };

  it("names the published versions active runs stay on, and leaves Draft runs out", () => {
    expect(runsLeftOnOlderVersions([item(6, 0)])).toBeNull();
    expect(runsLeftOnOlderVersions([item(6, 2), item(null, 3)])).toBe(
      "2 active runs stay on v6."
    );
    expect(runsLeftOnOlderVersions([item(6, 1), item(4, 1)])).toBe(
      "2 active runs stay on v4 and v6."
    );
  });
});

describe("ReviewSheet Lifecycle Node", () => {
  const thanks = mail("thanks", "Send thanks", "Thanks for your payment.");
  const start = {
    id: "start",
    source: "lifecycle",
    target: "thanks",
    sourceHandle: "started",
  };

  it("says what starts and stops the workflow on a first publish, and no raw settings", async () => {
    const firstPublish: WorkflowComparisonPayload = {
      baseVersion: null,
      proposedVersion: 1,
      baseGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
      draftGraph: createSerializedWorkflowGraph({
        nodes: [startingOn("billing/payment.settled"), thanks],
        edges: [start],
      }),
      hasChanges: true,
      nodeChanges: [
        { nodeId: "lifecycle", kind: "added", fields: [] },
        { nodeId: "thanks", kind: "added", fields: [] },
      ],
      edgeChanges: [{ edgeId: "start", kind: "added" }],
    };
    stubServer(firstPublish);
    const view = await renderSheet({ payload: firstPublish });
    await view.findByRole("heading", { name: "Publish v1" });

    expect(
      view.getByRole("region", { name: "Starts when" }).textContent
    ).toContain("Starts when Payment settled arrives.");
    expect(
      view.getByRole("region", { name: "Stops when" }).textContent
    ).toContain("Appointment canceled stops a run in progress.");
    expect(sheet(view)?.textContent).not.toMatch(/Configuration value/u);
  });

  it("shows the sentences a changed Lifecycle Node had and has", async () => {
    const changedStart: WorkflowComparisonPayload = {
      baseVersion: comparison.baseVersion,
      proposedVersion: 8,
      baseGraph: createSerializedWorkflowGraph({
        nodes: [startingOn("billing/payment.settled"), thanks],
        edges: [start],
      }),
      draftGraph: createSerializedWorkflowGraph({
        nodes: [startingOn("billing/payment.refunded"), thanks],
        edges: [start],
      }),
      hasChanges: true,
      nodeChanges: [
        {
          nodeId: "lifecycle",
          kind: "modified",
          fields: [
            {
              path: ["data", "config", "lifecycleRules", "startEvents"],
              kind: "modified",
              before: ["billing/payment.settled"],
              after: ["billing/payment.refunded"],
            },
          ],
        },
      ],
      edgeChanges: [],
    };
    stubServer(changedStart);
    const view = await renderSheet({ payload: changedStart });
    await view.findByRole("heading", { name: "Publish v8" });

    const starts = view.getByRole("region", { name: "Starts when" });
    expect(starts.querySelector(".line-through")?.textContent).toBe(
      "Starts when Payment settled arrives."
    );
    expect(starts.textContent).toContain(
      "Starts when Payment refunded arrives."
    );
  });
});
