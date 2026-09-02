import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  rpcErrorResponse,
  rpcJsonResponse,
} from "#src/lib/rpc-fetch-test-support";
import { orpcQuery } from "#src/lib/rpc-query";
import type { WorkflowVersionUsageItem } from "@wfgraph/shared/graph/publication-contracts";
import { WorkflowVersionUsage } from "./workflow-version-usage";
import { versionUsagePollInterval } from "./version-usage-poll";

function publishedUsage(
  overrides: Partial<
    Extract<WorkflowVersionUsageItem, { kind: "published" }>
  > = {}
): WorkflowVersionUsageItem {
  return {
    id: "version_4",
    kind: "published",
    version: 4,
    publishedAt: "2026-08-23T00:00:00.000Z",
    isCurrent: true,
    activeRunCount: 0,
    oldestActiveRunAt: null,
    actionIds: ["example/send"],
    missingActionIds: [],
    catalogMatches: true,
    ...overrides,
  };
}

function draftUsage(
  overrides: Partial<
    Extract<WorkflowVersionUsageItem, { kind: "draft_snapshot" }>
  > = {}
): WorkflowVersionUsageItem {
  return {
    id: "snapshot_1",
    kind: "draft_snapshot",
    version: null,
    publishedAt: "2026-08-23T00:00:00.000Z",
    isCurrent: false,
    activeRunCount: 1,
    oldestActiveRunAt: "2026-08-23T01:00:00.000Z",
    actionIds: ["example/send"],
    missingActionIds: [],
    catalogMatches: true,
    ...overrides,
  };
}

function renderUsage(items?: WorkflowVersionUsageItem[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (items) {
    queryClient.setQueryData(
      orpcQuery.workflow.getVersionUsage.queryKey({
        input: { workflowId: "workflow_1" },
      }),
      { items }
    );
  }

  return render(
    <QueryClientProvider client={queryClient}>
      <WorkflowVersionUsage workflowId="workflow_1" />
    </QueryClientProvider>
  );
}

describe("WorkflowVersionUsage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows an explicit busy state while version usage is loading", () => {
    vi.stubGlobal("fetch", () => new Promise(() => undefined));

    const view = renderUsage();

    expect(
      view.getByRole("region", { name: "In use" }).getAttribute("aria-busy")
    ).toBe("true");
    expect(
      view.getByText("Loading", { selector: "span[role=status]" })
    ).toBeDefined();
    expect(view.getByText("Loading version usage")).toBeDefined();
  });

  it("offers a retry after a usage request fails and replaces the error with its result", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", () => {
      attempts += 1;
      return attempts === 1
        ? Promise.resolve(
            rpcErrorResponse({
              code: "INTERNAL_SERVER_ERROR",
              status: 500,
              message: "Unavailable",
            })
          )
        : Promise.resolve(rpcJsonResponse({ items: [publishedUsage()] }));
    });

    const view = renderUsage();

    await waitFor(() =>
      expect(view.getByText("Unable to check version usage")).toBeDefined()
    );
    fireEvent.click(view.getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(
        view.getByRole("button", {
          name: /Version 4.*No active runs.*Toggle details/,
        })
      ).toBeDefined()
    );
    expect(view.queryByText("Unable to check version usage")).toBeNull();
  });

  it("labels the current published version and its zero active runs without calling it empty", () => {
    const view = renderUsage([publishedUsage()]);

    expect(
      view.getByRole("heading", { name: "In use · 1 version" })
    ).toBeDefined();
    expect(view.getByText("No active runs")).toBeDefined();
    expect(view.queryByText("No versions in use")).toBeNull();
  });

  it("explains when the workflow has neither a current nor active version", () => {
    const view = renderUsage([]);

    expect(
      view.getByRole("heading", { name: "In use · 0 versions" })
    ).toBeDefined();
    expect(view.getByText("No current or active versions")).toBeDefined();
  });

  it("discloses a healthy current published version with accessible details", () => {
    const view = renderUsage([
      publishedUsage({
        activeRunCount: 3,
        oldestActiveRunAt: "2026-08-23T01:00:00.000Z",
      }),
    ]);

    const trigger = view.getByRole("button", {
      name: /Version 4.*Current.*3 active runs.*Oldest run started.*Toggle details/,
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(view.getByText("3 active runs")).toBeDefined();
    expect(view.getByText(/Oldest run started/)).toBeDefined();

    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(view.getByText("example/send")).toBeDefined();
  });

  it("describes catalog drift from a draft snapshot as a change since that version", () => {
    const view = renderUsage([draftUsage({ catalogMatches: false })]);

    expect(view.getByText("Catalog changed since this version")).toBeDefined();
    expect(view.queryByText("Catalog changed since publish")).toBeNull();
  });

  it("shows missing actions and catalog drift for a published version", () => {
    const view = renderUsage([
      publishedUsage({
        catalogMatches: false,
        actionIds: ["example/send", "removed/action"],
        missingActionIds: ["removed/action"],
      }),
    ]);

    expect(view.getByText("1 action missing")).toBeDefined();
    expect(view.getByText("Catalog changed since this version")).toBeDefined();
  });

  it("polls more frequently while a version has active runs", () => {
    expect(
      versionUsagePollInterval([publishedUsage({ activeRunCount: 1 })])
    ).toBe(10_000);
    expect(versionUsagePollInterval([publishedUsage()])).toBe(30_000);
    expect(versionUsagePollInterval(undefined)).toBe(30_000);
  });
});
