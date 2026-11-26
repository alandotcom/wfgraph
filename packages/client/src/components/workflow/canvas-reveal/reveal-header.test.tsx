import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider as JotaiProvider, useAtomValue } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
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
import { activeAgentTurnIdAtom } from "#src/lib/workflow-ui-store";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import {
  type WfGraphOperationId,
  WfGraphOperationIds,
} from "@wfgraph/shared/authorization/operations";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { RevealHeader, type RevealHeaderControls } from "./reveal-header";

/**
 * The header over the "send" step's stored label, as the shell builds it from
 * the step kind's model, so a rename shows in the title as it is typed.
 */
function SendHeader({ controls }: { controls: RevealHeaderControls }) {
  const label =
    useAtomValue(nodesAtom).find((node) => node.id === "send")?.data.label ??
    "";
  return (
    <RevealHeader
      controls={controls}
      model={{
        title: label === "" ? "Send email" : label,
        name: { nodeId: "send", label, fallback: "Send email" },
        status: { text: "2 issues", tone: "warning" },
        showsBack: false,
      }}
    />
  );
}

// The ⋯ menu offers topology commands, which need the desktop layout, and
// another file in the worker may have left happy-dom at phone width.
beforeEach(() => {
  (
    window as unknown as {
      happyDOM: { setViewport: (viewport: { width: number }) => void };
    }
  ).happyDOM.setViewport({ width: 1440 });
});
afterEach(resetAuthorizationGrantsForTests);

function renderHeader(
  onClose: () => void = () => {},
  selectedId: "send" | "group" = "send",
  grants: readonly WfGraphOperationId[] = WfGraphOperationIds
) {
  installAuthorizationGrantsForTests(grants);
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
      {
        id: "group",
        type: "group",
        position: { x: 0, y: 400 },
        width: 400,
        height: 300,
        data: { label: "Follow-ups", type: "group" },
      },
      ...["first", "second"].map((id) => ({
        id,
        type: "action",
        parentId: "group",
        extent: "parent" as const,
        position: { x: 0, y: 0 },
        data: { label: id, type: "action" as const, config: {} },
      })),
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
  act(() => store.set(selectOnlyNodeAtom, selectedId));
  render(
    <JotaiProvider store={store}>
      <QueryClientProvider client={new QueryClient()}>
        <ExtensionCatalogProvider value={emptyExtensionCatalog}>
          <OverlayProvider>
            <SendHeader
              controls={{
                onBack: () => {},
                onClose,
                titleRef: { current: null },
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
      (screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value
    ).toBe("Send reminder");
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

  it("names a Group's kind in its ⋯ menu", async () => {
    renderHeader(() => {}, "group");
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));

    const items = (await screen.findAllByRole("menuitem")).map(
      (item) => item.textContent
    );
    expect(items.some((item) => item?.startsWith("Duplicate group"))).toBe(
      true
    );
    expect(items).toContain("Delete Group and steps");
    expect(items.some((item) => item?.includes("Follow-ups"))).toBe(false);
  });

  it("offers no ⋯ menu while the canvas takes no edits", () => {
    const store = renderHeader();
    expect(screen.getByRole("button", { name: "More actions" })).toBeTruthy();

    // A running agent turn holds the draft, as the canvas does.
    act(() => store.set(activeAgentTurnIdAtom, Symbol("turn")));

    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });

  it("runs the shell's close on Close", () => {
    const onClose = vi.fn();
    renderHeader(onClose);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renames the step as the title is typed, and Enter keeps the name", () => {
    const store = renderHeader();
    const field = screen.getByRole("textbox", { name: "Name" });
    const labelOf = () =>
      store.get(nodesAtom).find((node) => node.id === "send")?.data.label;

    field.focus();
    fireEvent.change(field, { target: { value: "Send confirmation" } });
    expect(labelOf()).toBe("Send confirmation");

    fireEvent.keyDown(field, { key: "Enter" });
    expect(labelOf()).toBe("Send confirmation");
    // Focus moves to the heading, so the next Escape is the Inspector's.
    expect(document.activeElement).toBe(
      document.querySelector('[data-slot="reveal-title"]')
    );
  });

  it("puts the name back on Escape and keeps the Escape from the Inspector", () => {
    const store = renderHeader();
    const field = screen.getByRole("textbox", { name: "Name" });
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    try {
      field.focus();
      fireEvent.change(field, { target: { value: "Send" } });
      fireEvent.change(field, { target: { value: "" } });
      // An empty label shows the kind's own name in its place.
      expect((field as HTMLInputElement).placeholder).toBe("Send email");

      fireEvent.keyDown(field, { key: "Escape" });
    } finally {
      document.removeEventListener("keydown", outer);
    }

    expect(
      store.get(nodesAtom).find((node) => node.id === "send")?.data.label
    ).toBe("Send reminder");
    expect(outer).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      document.querySelector('[data-slot="reveal-title"]')
    );
  });

  it("shows the name as plain text to a person who cannot edit the workflow", () => {
    renderHeader(() => {}, "send", []);
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Send reminder" })).toBeTruthy();
  });

  it("shows the name as plain text while an agent turn holds the draft", () => {
    const store = renderHeader();
    act(() => store.set(activeAgentTurnIdAtom, Symbol("turn")));
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Send reminder" })).toBeTruthy();
  });
});
