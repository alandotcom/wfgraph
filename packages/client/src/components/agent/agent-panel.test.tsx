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
}

describe("AgentPanel", () => {
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
