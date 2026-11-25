import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicationChip } from "#src/components/workflow/publication-chip";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import {
  extractRpcProcedurePath,
  rpcJsonResponse,
  rpcUrl,
} from "#src/lib/rpc-fetch-test-support";
import type { WorkflowCommand } from "#src/lib/workflow-commands";
import {
  currentWorkflowIdAtom,
  currentWorkflowModeAtom,
} from "#src/lib/workflow-save-store";
import {
  WfGraphOperationIds,
  WfGraphOperations,
} from "@wfgraph/shared/authorization/operations";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";

const WORKFLOW_ID = "wf_1";

function renderChip(options: {
  mode?: "live" | "test";
  published?: boolean;
  paused?: boolean;
  hasUnpublishedChanges?: boolean;
  canUpdate?: boolean;
}) {
  const mode = options.mode ?? "live";
  installAuthorizationGrantsForTests(
    (options.canUpdate ?? true)
      ? WfGraphOperationIds
      : WfGraphOperationIds.filter(
          (operationId) => operationId !== WfGraphOperations.workflowUpdate.id
        )
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (extractRpcProcedurePath(rpcUrl(input)) !== "workflow/getById") {
        return new Response("{}", { status: 404 });
      }
      return rpcJsonResponse({
        id: WORKFLOW_ID,
        name: "Appointment reminders",
        isPaused: options.paused ?? false,
        mode,
        visibility: "private",
        createdAt: "2026-03-01T09:00:00.000Z",
        updatedAt: "2026-03-01T09:30:00.000Z",
        graph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
        hasUnpublishedChanges: options.hasUnpublishedChanges ?? false,
        publishedVersionId: options.published ? "ver_2" : undefined,
        publishedVersion: options.published ? 2 : undefined,
      });
    })
  );
  const store = createStore();
  store.set(currentWorkflowIdAtom, WORKFLOW_ID);
  store.set(currentWorkflowModeAtom, mode);
  const showHistory = vi.fn();
  const review = vi.fn();
  const commands: WorkflowCommand[] = [
    {
      id: "version-history",
      group: "workflow",
      label: "Version history",
      keywords: "",
      disabled: false,
      execute: showHistory,
    },
    {
      id: "review-changes",
      group: "workflow",
      label: "Review changes",
      keywords: "",
      disabled: false,
      execute: review,
    },
  ];
  const view = render(
    <JotaiProvider store={store}>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <PublicationChip commands={commands} workflowId={WORKFLOW_ID} />
      </QueryClientProvider>
    </JotaiProvider>
  );
  const open = async () => {
    const chip = await view.findByRole("button", { name: /^Publication: / });
    fireEvent.keyDown(chip, { key: "ArrowDown" });
    fireEvent.keyUp(chip, { key: "ArrowDown" });
    return chip;
  };
  return { view, open, showHistory, review };
}

afterEach(() => {
  resetAuthorizationGrantsForTests();
  vi.unstubAllGlobals();
});

describe("PublicationChip", () => {
  it("states the publication in the Workflows list's words", async () => {
    const { view } = renderChip({
      published: true,
      hasUnpublishedChanges: true,
    });

    expect(
      await view.findByRole("button", {
        name: "Publication: Live · v2 · changes not published",
      })
    ).toBeTruthy();
  });

  it("says nothing until the workflow has loaded", () => {
    const { view } = renderChip({ published: true });

    expect(view.queryByRole("button", { name: /^Publication: / })).toBeNull();
  });

  it("offers Published mode, Pause, Version history and Review changes", async () => {
    const { view, open, showHistory, review } = renderChip({
      mode: "test",
      published: true,
    });
    const chip = await open();
    expect(chip.getAttribute("aria-label")).toBe("Publication: Test · v2");

    const test = view.getByRole("menuitemradio", {
      name: /^Test.*Real Events still start runs, and each step follows its In test runs setting/,
    });
    expect(test.getAttribute("aria-checked")).toBe("true");
    expect(
      view.getByRole("menuitemradio", {
        name: /^Live.*every step reaches real recipients/,
      })
    ).toBeTruthy();
    // A version is published, so the mode is already in force.
    expect(view.queryByText("Takes effect on publish")).toBeNull();
    // Pause says what it does before it is pressed.
    expect(
      view.getByRole("menuitem", {
        name: "Pause workflow New Events, schedules and manual runs start nothing. Runs in progress continue.",
      })
    ).toBeTruthy();

    fireEvent.click(view.getByRole("menuitem", { name: "Version history" }));
    expect(showHistory).toHaveBeenCalledTimes(1);
    await open();
    fireEvent.click(view.getByRole("menuitem", { name: "Review changes" }));
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("says when the mode takes effect before the first publish, with no Pause", async () => {
    const { view, open } = renderChip({});
    const chip = await open();

    expect(chip.getAttribute("aria-label")).toBe(
      "Publication: Never published"
    );
    expect(view.getByText("Takes effect on publish")).toBeTruthy();
    expect(view.queryByRole("menuitem", { name: /Pause/ })).toBeNull();
  });

  it("says Paused, and offers Resume, while the workflow is paused", async () => {
    const { view, open } = renderChip({ published: true, paused: true });
    const chip = await open();

    // A paused chip keeps the mode and version the pause holds back.
    expect(chip.getAttribute("aria-label")).toBe(
      "Publication: Paused · Live · v2"
    );
    expect(
      view.getByRole("menuitem", {
        name: "Resume workflow Events, schedules and manual runs start runs again.",
      })
    ).toBeTruthy();
  });

  it("shows a viewer the mode without letting them change it", async () => {
    const { view, open } = renderChip({ published: true, canUpdate: false });
    await open();

    await waitFor(() =>
      expect(
        view
          .getByRole("menuitemradio", { name: /^Live/ })
          .getAttribute("aria-disabled")
      ).toBe("true")
    );
  });
});
