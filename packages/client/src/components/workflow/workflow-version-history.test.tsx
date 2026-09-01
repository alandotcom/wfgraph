import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import {
  beginWorkflowComparisonRequestAtom,
  installWorkflowComparisonAtom,
  setComparisonSubviewAtom,
} from "#src/lib/workflow-comparison-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { orpcQuery } from "#src/lib/rpc-query";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { WorkflowVersionHistory } from "./workflow-version-history";
import type {
  WorkflowVersionSummary,
  WorkflowVersionUsageItem,
} from "@wfgraph/shared/graph/publication-contracts";

function renderHistory(
  historyItems: WorkflowVersionSummary[],
  usageItems: WorkflowVersionUsageItem[],
  canReadUsage = true
) {
  installAuthorizationGrantsForTests([
    WfGraphOperations.workflowGetVersionHistory.id,
    ...(canReadUsage ? [WfGraphOperations.workflowGetVersionUsage.id] : []),
  ]);
  const store = createStore();
  store.set(currentWorkflowIdAtom, "workflow_1");
  const epoch = store.set(beginWorkflowComparisonRequestAtom, "workflow_1");
  store.set(installWorkflowComparisonAtom, {
    workflowId: "workflow_1",
    epoch,
    payload: {
      baseVersion: historyItems[0] ?? null,
      proposedVersion: 2,
      baseGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
      draftGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
      hasChanges: false,
      nodeChanges: [],
      edgeChanges: [],
    },
  });
  store.set(setComparisonSubviewAtom, {
    workflowId: "workflow_1",
    subview: "history",
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  const historyOptions = orpcQuery.workflow.getVersionHistory.infiniteOptions({
    input: () => ({ workflowId: "workflow_1", cursor: undefined }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  queryClient.setQueryData(historyOptions.queryKey, {
    pages: [{ items: historyItems, nextCursor: null }],
    pageParams: [undefined],
  });
  queryClient.setQueryData(
    orpcQuery.workflow.getVersionUsage.queryKey({
      input: { workflowId: "workflow_1" },
    }),
    { items: usageItems }
  );
  const actions = {
    canRestore: false,
    isPending: false,
    restore: { isPending: false },
  } as never;

  return render(
    <QueryClientProvider client={queryClient}>
      <JotaiProvider store={store}>
        <WorkflowVersionHistory actions={actions} />
      </JotaiProvider>
    </QueryClientProvider>
  );
}

describe("WorkflowVersionHistory", () => {
  afterEach(() => {
    resetAuthorizationGrantsForTests();
  });

  it("uses pressed state for history selection while retaining the Current label", () => {
    const view = renderHistory(
      [
        {
          id: "version_1",
          version: 1,
          publishedAt: "2026-08-23T00:00:00.000Z",
          isCurrent: true,
        },
      ],
      []
    );

    const row = view.getByRole("button", { name: /Version 1/ });
    expect(row.getAttribute("aria-pressed")).toBe("true");
    expect(row.textContent).toContain("Current");
    expect(
      view.queryByRole("button", { name: /Restore version 1 as draft/ })
    ).toBeNull();
  });

  it("shows active draft usage and identifies missing actions", () => {
    const view = renderHistory(
      [],
      [
        {
          id: "snapshot_1",
          kind: "draft_snapshot",
          version: null,
          publishedAt: "2026-08-23T00:00:00.000Z",
          isCurrent: false,
          activeRunCount: 2,
          oldestActiveRunAt: "2026-08-23T01:00:00.000Z",
          actionIds: ["example/send", "removed/action"],
          missingActionIds: ["removed/action"],
          catalogMatches: false,
        },
      ]
    );

    const usageRow = view.getByRole("button", {
      name: /Draft.*2 active runs.*1 action missing.*Catalog changed since this version.*Toggle details/,
    });
    expect(view.getByText("1 action missing")).toBeDefined();

    fireEvent.click(usageRow);
    expect(view.getByText("removed/action")).toBeDefined();
    expect(view.getByText("Missing")).toBeDefined();
  });

  it("hides version usage entirely without permission", () => {
    const view = renderHistory([], [], false);

    expect(view.queryByRole("region", { name: "In use" })).toBeNull();
  });
});
