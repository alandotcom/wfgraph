import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentPanel } from "#src/components/agent/agent-panel";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import { WfGraphOperationIds } from "@wfgraph/shared/authorization/operations";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

beforeEach(() => {
  installAuthorizationGrantsForTests(WfGraphOperationIds);
});

afterEach(() => {
  resetAuthorizationGrantsForTests();
  localStorage.clear();
});

function renderOpenPanel() {
  const store = createStore();
  render(
    <JotaiProvider store={store}>
      <ExtensionCatalogProvider value={emptyExtensionCatalog}>
        <AgentPanel workflowId="workflow_1" />
      </ExtensionCatalogProvider>
    </JotaiProvider>
  );
  fireEvent.click(screen.getByRole("button", { name: "Agent" }));
  return {
    card: () => screen.getByRole("region", { name: "Build agent" }),
    grip: () => screen.getByRole("button", { name: "Resize the agent panel" }),
  };
}

describe("AgentPanel resize grip", () => {
  it("stops resizing when the browser cancels the drag", () => {
    const { card, grip } = renderOpenPanel();
    const before = card().style.width;

    fireEvent.pointerDown(grip(), { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerCancel(grip(), { pointerId: 1 });
    fireEvent.pointerMove(grip(), { pointerId: 1, clientX: 220, clientY: 100 });

    expect(card().style.width).toBe(before);
  });

  it("stops resizing when the grip loses its pointer capture", () => {
    const { card, grip } = renderOpenPanel();
    const before = card().style.width;

    fireEvent.pointerDown(grip(), { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent(
      grip(),
      new PointerEvent("lostpointercapture", { bubbles: true, pointerId: 1 })
    );
    fireEvent.pointerMove(grip(), { pointerId: 1, clientX: 220, clientY: 100 });

    expect(card().style.width).toBe(before);
  });
});

describe("AgentPanel thread", () => {
  function storeThread(text: string) {
    localStorage.setItem(
      "wfgraph:agent-thread:workflow_1",
      JSON.stringify({
        version: 1,
        messages: [
          {
            parentId: null,
            message: {
              id: "m1",
              role: "user",
              createdAt: "2026-11-11T10:00:00.000Z",
              content: [{ type: "text", text }],
              attachments: [],
              metadata: { custom: {} },
            },
          },
        ],
      })
    );
  }

  it("restores the stored thread when the panel opens", async () => {
    storeThread("Add a Slack step");
    renderOpenPanel();

    expect(await screen.findByText("Add a Slack step")).toBeTruthy();
  });

  it("clears the thread and its stored copy on New conversation", async () => {
    storeThread("Add a Slack step");
    renderOpenPanel();
    await screen.findByText("Add a Slack step");

    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));

    await waitFor(() => {
      expect(screen.queryByText("Add a Slack step")).toBeNull();
    });
    expect(localStorage.getItem("wfgraph:agent-thread:workflow_1")).toBeNull();
  });
});
