import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { detailsFloatOpenAtom } from "#src/components/workflow/columns/editor-columns-store";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import {
  loadWorkflowGraphAtom,
  nodesAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import { WfGraphOperationIds } from "@wfgraph/shared/authorization/operations";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { RevealHeader } from "./reveal-header";

afterEach(resetAuthorizationGrantsForTests);

function renderHeader() {
  installAuthorizationGrantsForTests(WfGraphOperationIds);
  const store = createStore();
  store.set(currentWorkflowIdAtom, "wf_1");
  store.set(loadWorkflowGraphAtom, {
    nodes: [
      {
        id: "lifecycle",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: { label: "", type: "lifecycle", config: {} },
      },
      {
        id: "send",
        type: "action",
        position: { x: 0, y: 200 },
        data: { label: "Send reminder", type: "action", config: {} },
      },
    ],
    edges: [
      {
        id: "edge",
        source: "lifecycle",
        target: "send",
        sourceHandle: "started",
      },
    ],
  });
  showWorkspaceRoute(store, {});
  act(() => store.set(selectOnlyNodeAtom, "send"));
  store.set(detailsFloatOpenAtom, true);
  render(
    <JotaiProvider store={store}>
      <QueryClientProvider client={new QueryClient()}>
        <ExtensionCatalogProvider value={emptyExtensionCatalog}>
          <OverlayProvider>
            <RevealHeader
              controls={{ onBack: () => {}, titleRef: { current: null } }}
              model={{
                title: "Send reminder",
                status: { text: "2 issues", tone: "warning" },
                showsBack: false,
              }}
            />
          </OverlayProvider>
        </ExtensionCatalogProvider>
      </QueryClientProvider>
    </JotaiProvider>
  );
  return store;
}

describe("RevealHeader", () => {
  it("names the step by number and title with its status", () => {
    renderHeader();
    expect(screen.getByRole("heading", { name: "Send reminder" })).toBeTruthy();
    expect(
      document.querySelector('[data-slot="reveal-number"]')?.textContent
    ).toBe("1");
    expect(screen.getByText("2 issues")).toBeTruthy();
  });

  it("offers the step's commands in its ⋯ menu, without Edit", async () => {
    const store = renderHeader();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));

    const items = (await screen.findAllByRole("menuitem")).map(
      (item) => item.textContent
    );
    // The header names the step, so each row names its kind instead.
    expect(items).toContain("Disable step");
    expect(items).toContain("Add step after");
    expect(items.some((item) => item?.startsWith("Duplicate step"))).toBe(true);
    expect(items).toContain("Delete step");
    expect(items.some((item) => item?.includes("Send reminder"))).toBe(false);
    expect(items.some((item) => item?.startsWith("Edit"))).toBe(false);

    fireEvent.click(screen.getByRole("menuitem", { name: /^Disable step/u }));
    expect(
      store.get(nodesAtom).find((node) => node.id === "send")?.data.enabled
    ).toBe(false);
  });

  it("closes the Inspector on Close and keeps the selection", () => {
    const store = renderHeader();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(store.get(detailsFloatOpenAtom)).toBe(false);
  });
});
