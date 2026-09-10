import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MigrationDialog } from "#src/components/workflow/migration-dialog";
import {
  extractRpcProcedurePath,
  parseRpcRequestInput,
  rpcErrorResponse,
  rpcJsonResponse,
  rpcUrl,
} from "#src/lib/rpc-fetch-test-support";
import { mutationErrorToast } from "#src/lib/query-client";
import { orpcQuery } from "#src/lib/rpc-query";
import type {
  WorkflowMigrationPayload,
  WorkflowMigrationPreviewPayload,
} from "@wfgraph/shared/graph/migration-contracts";

const preview: WorkflowMigrationPreviewPayload = {
  targetVersionId: "version_8",
  targetVersionNumber: 8,
  eligible: [
    {
      executionId: "run_aaaaaaaaaa",
      fromVersionNumber: 7,
      parkedNodeIds: ["wait_1"],
    },
    {
      executionId: "run_bbbbbbbbbb",
      fromVersionNumber: 6,
      parkedNodeIds: ["wait_1"],
    },
  ],
  refused: [
    {
      executionId: "run_cccccccccc",
      fromVersionNumber: 7,
      reason: "executing",
    },
    {
      executionId: "run_dddddddddd",
      fromVersionNumber: null,
      reason: "draft_run",
    },
    {
      executionId: "run_eeeeeeeeee",
      fromVersionNumber: 5,
      reason: "unresolved_reference",
      detail: "after_1.subject",
    },
  ],
  alreadyCurrentCount: 4,
};

/**
 * Answers the two procedures the dialog calls: the preflight report a case
 * hands in, and a migrate call that moves every id it was sent. `migrateRequests`
 * collects the body of each migrate call.
 */
function stubRpc(options: {
  report: WorkflowMigrationPreviewPayload;
  migrateRequests?: Array<Record<string, unknown>>;
  failMigrateCall?: number;
}) {
  let migrateCall = 0;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = extractRpcProcedurePath(rpcUrl(input));
      if (path === "workflow/previewMigration") {
        return rpcJsonResponse(options.report);
      }
      const body = await parseRpcRequestInput(init);
      options.migrateRequests?.push(body);
      migrateCall += 1;
      if (migrateCall === options.failMigrateCall) {
        return rpcErrorResponse({
          code: "INTERNAL_SERVER_ERROR",
          status: 500,
          message: "Migration failed",
        });
      }
      const executionIds = Array.isArray(body.executionIds)
        ? (body.executionIds as string[])
        : [];
      const payload: WorkflowMigrationPayload = {
        targetVersionId: "version_8",
        targetVersionNumber: 8,
        outcomes: executionIds.map((executionId) => ({
          executionId,
          status: "migrated",
          signaled: true,
        })),
      };
      return rpcJsonResponse(payload);
    }
  );
}

function renderDialog(cachedReport?: WorkflowMigrationPreviewPayload) {
  const queryClient = new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        const message = mutationErrorToast(error, mutation.meta);
        if (message !== null) {
          toast.error(message);
        }
      },
    }),
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  if (cachedReport) {
    queryClient.setQueryData(
      orpcQuery.workflow.previewMigration.queryKey({
        input: { workflowId: "workflow_1" },
      }),
      cachedReport
    );
  }

  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <MigrationDialog onOpenChange={vi.fn()} open workflowId="workflow_1" />
      </QueryClientProvider>
    ),
    queryClient,
  };
}

describe("MigrationDialog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("counts the runs the target version can take over and names each refusal", async () => {
    stubRpc({ report: preview });
    const view = renderDialog();

    expect(
      view.getByRole("dialog", { name: "Migrate active runs" })
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        view.getByText("Runs parked on a Wait move to version 8.")
      ).toBeTruthy()
    );
    expect(view.getByText("Ready to move").nextSibling?.textContent).toBe("2");
    expect(view.getByText("Cannot move").nextSibling?.textContent).toBe("3");
    expect(
      view.getByText("Already on version 8").nextSibling?.textContent
    ).toBe("4");
    expect(
      view.getByText(
        "Not parked on a Wait. Try again once the run reaches one."
      )
    ).toBeTruthy();
    expect(view.getByText("This run is on a draft.")).toBeTruthy();
    expect(
      view.getByText(
        "A field below the Wait reads an output this run never produced (after_1.subject)."
      )
    ).toBeTruthy();
    expect(view.getByText("run_cccc")).toBeTruthy();
    expect(view.getByText("Draft")).toBeTruthy();
  });

  it("withholds the report of an earlier open until the fresh one lands", async () => {
    stubRpc({ report: { ...preview, alreadyCurrentCount: 9 } });
    const view = renderDialog(preview);

    expect(view.getByText("Checking which runs can move")).toBeTruthy();
    expect(view.queryByText("Already on version 8")).toBeNull();
    expect(
      view
        .getByRole("button", { name: "Migrate 0 runs" })
        .hasAttribute("disabled")
    ).toBe(true);

    await waitFor(() =>
      expect(
        view.getByText("Already on version 8").nextSibling?.textContent
      ).toBe("9")
    );
  });

  it("withholds a cached report when its refetch fails", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        rpcErrorResponse({
          code: "INTERNAL_SERVER_ERROR",
          status: 500,
          message: "Preview failed",
        })
      )
    );
    const view = renderDialog(preview);

    await waitFor(() =>
      expect(view.getByText("Unable to check which runs can move")).toBeTruthy()
    );
    expect(view.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(view.queryByText("Already on version 8")).toBeNull();
    expect(view.queryByText("Staying where they are")).toBeNull();
    expect(
      view
        .getByRole("button", { name: "Migrate 0 runs" })
        .hasAttribute("disabled")
    ).toBe(true);
  });

  it("disables the confirm button when no run can move", async () => {
    stubRpc({ report: { ...preview, eligible: [] } });
    const view = renderDialog();

    await waitFor(() =>
      expect(view.getByRole("button", { name: "Migrate 0 runs" })).toBeTruthy()
    );
    expect(
      view
        .getByRole("button", { name: "Migrate 0 runs" })
        .hasAttribute("disabled")
    ).toBe(true);
  });

  it("sends only the eligible run ids and the target version", async () => {
    const migrateRequests: Array<Record<string, unknown>> = [];
    stubRpc({ report: preview, migrateRequests });

    const view = renderDialog();
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Migrate 2 runs" })).toBeTruthy()
    );
    fireEvent.click(view.getByRole("button", { name: "Migrate 2 runs" }));

    await waitFor(() => expect(migrateRequests.length).toBe(1));
    expect(migrateRequests[0]).toEqual({
      workflowId: "workflow_1",
      targetVersionId: "version_8",
      executionIds: ["run_aaaaaaaaaa", "run_bbbbbbbbbb"],
    });
  });

  it("splits more than 500 run ids across sequential migrate calls", async () => {
    const executionIds = Array.from(
      { length: 501 },
      (_unused, index) => `run_${index}`
    );
    const migrateRequests: Array<Record<string, unknown>> = [];
    stubRpc({
      report: {
        ...preview,
        eligible: executionIds.map((executionId) => ({
          executionId,
          fromVersionNumber: 7,
          parkedNodeIds: ["wait_1"],
        })),
      },
      migrateRequests,
    });

    const view = renderDialog();
    await waitFor(() =>
      expect(
        view.getByRole("button", { name: "Migrate 501 runs" })
      ).toBeTruthy()
    );
    fireEvent.click(view.getByRole("button", { name: "Migrate 501 runs" }));

    await waitFor(() => expect(migrateRequests.length).toBe(2));
    expect(
      migrateRequests.map(
        (request) => (request.executionIds as string[]).length
      )
    ).toEqual([500, 1]);
    expect(migrateRequests[1]?.executionIds).toEqual(["run_500"]);
  });

  it("refreshes run history and reports completed work when a later batch fails", async () => {
    const infoToast = vi.spyOn(toast, "info").mockImplementation(() => "");
    const errorToast = vi.spyOn(toast, "error").mockImplementation(() => "");
    const executionIds = Array.from(
      { length: 501 },
      (_unused, index) => `run_${index}`
    );
    const migrateRequests: Array<Record<string, unknown>> = [];
    stubRpc({
      report: {
        ...preview,
        eligible: executionIds.map((executionId) => ({
          executionId,
          fromVersionNumber: 7,
          parkedNodeIds: ["wait_1"],
        })),
      },
      migrateRequests,
      failMigrateCall: 2,
    });
    const view = renderDialog();
    const runHistoryKey = orpcQuery.workflow.getExecutions.queryKey({
      input: { workflowId: "workflow_1" },
    });
    view.queryClient.setQueryData(runHistoryKey, {
      items: [],
      supersededCount: 0,
      refusedStarts: [],
      cancelNotDelivered: [],
    });

    fireEvent.click(
      await view.findByRole("button", { name: "Migrate 501 runs" })
    );

    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith("Unable to migrate the runs")
    );
    expect(migrateRequests.length).toBe(2);
    expect(infoToast).toHaveBeenCalledWith(
      "500 runs moved before the migration failed"
    );
    expect(infoToast.mock.invocationCallOrder[0]).toBeLessThan(
      errorToast.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(
      view.queryClient.getQueryCache().find({
        queryKey: runHistoryKey,
        exact: true,
      })?.state.isInvalidated
    ).toBe(true);
  });
});
