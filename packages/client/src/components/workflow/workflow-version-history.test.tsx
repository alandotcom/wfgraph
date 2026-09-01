import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { describe, expect, it } from "vitest";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import {
  beginWorkflowComparisonRequestAtom,
  installWorkflowComparisonAtom,
  setComparisonSubviewAtom,
} from "#src/lib/workflow-comparison-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { orpcQuery } from "#src/lib/rpc-query";
import { WorkflowVersionHistory } from "./workflow-version-history";

describe("WorkflowVersionHistory", () => {
  it("uses pressed state for history selection while retaining the Current label", () => {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    const epoch = store.set(beginWorkflowComparisonRequestAtom, "workflow_1");
    store.set(installWorkflowComparisonAtom, {
      workflowId: "workflow_1",
      epoch,
      payload: {
        baseVersion: {
          id: "version_1",
          version: 1,
          publishedAt: "2026-08-23T00:00:00.000Z",
          isCurrent: true,
        },
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
    const options = orpcQuery.workflow.getVersionHistory.infiniteOptions({
      input: () => ({ workflowId: "workflow_1", cursor: undefined }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    });
    queryClient.setQueryData(options.queryKey, {
      pages: [
        {
          items: [
            {
              id: "version_1",
              version: 1,
              publishedAt: "2026-08-23T00:00:00.000Z",
              isCurrent: true,
            },
          ],
          nextCursor: null,
        },
      ],
      pageParams: [undefined],
    });
    const actions = {
      canRestore: false,
      isPending: false,
      restore: { isPending: false },
    } as never;
    const view = render(
      <QueryClientProvider client={queryClient}>
        <JotaiProvider store={store}>
          <WorkflowVersionHistory actions={actions} />
        </JotaiProvider>
      </QueryClientProvider>
    );

    const row = view.getByRole("button", { name: /Version 1/ });
    expect(row.getAttribute("aria-pressed")).toBe("true");
    expect(row.textContent).toContain("Current");
    expect(
      view.queryByRole("button", { name: /Restore version 1 as draft/ })
    ).toBeNull();
  });
});
