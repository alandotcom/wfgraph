import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayContainer } from "#src/components/overlays/overlay-container";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import type { Integration } from "#src/lib/rpc-client";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import { executionOverlayGraphAtom } from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import { WfGraphOperationIds } from "@wfgraph/shared/authorization/operations";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { RunFailureText } from "./workflow-run-failure";

const ACTION = "slack/send-message";

const catalog: ExtensionCatalog = {
  entities: [],
  events: [],
  actions: [
    {
      id: ACTION,
      label: "Send Message",
      description: "Post a message to a channel",
      category: "Slack",
      integration: "slack",
      configFields: [],
      outputFields: [],
    },
  ],
  integrations: [
    {
      type: "slack",
      label: "Slack",
      description: "Slack messaging",
      credentialFields: {},
      hasTest: false,
      hasWebhook: false,
    },
  ],
};

const connection: Integration = {
  id: "int_slack",
  name: "Acme Slack",
  type: "slack",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  configuredKeys: [],
  connectionDefaults: {},
};

/** The failed step as the graph the run pinned holds it. */
const failedStep: WorkflowNode = {
  id: "alert",
  type: "action",
  position: { x: 0, y: 0 },
  data: {
    label: "Alert the front desk",
    type: "action",
    config: { actionType: ACTION, integrationId: "int_slack" },
  },
};

function renderFailure(error: string, connections: Integration[]) {
  const store = createStore();
  // The pinned graph is shown only in the Runs workspace.
  showWorkspaceRoute(store, { view: "runs" });
  store.set(executionOverlayGraphAtom, { nodes: [failedStep], edges: [] });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(integrationsQueryOptions().queryKey, connections);
  // The cached list answers every read; a refetch or the dialog's own reads
  // wait on a request that never settles.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => undefined))
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <JotaiProvider store={store}>
        <ExtensionCatalogProvider value={catalog}>
          <OverlayProvider>
            <RunFailureText error={error} nodeId="alert" />
            <OverlayContainer />
          </OverlayProvider>
        </ExtensionCatalogProvider>
      </JotaiProvider>
    </QueryClientProvider>
  );
}

afterEach(() => {
  resetAuthorizationGrantsForTests();
  vi.unstubAllGlobals();
});

describe("RunFailureText", () => {
  it("names the Connection a provider refused and opens it for repair", async () => {
    installAuthorizationGrantsForTests(WfGraphOperationIds);
    const view = renderFailure("Failed to send Slack message: invalid_auth", [
      connection,
    ]);

    expect(
      view.getByText(
        "Slack rejected the credentials of the Connection Acme Slack."
      )
    ).toBeTruthy();
    expect(
      view.getByText("Failed to send Slack message: invalid_auth")
    ).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Edit connection" }));
    expect(await view.findByRole("dialog")).toBeTruthy();
  });

  it("offers no repair to a person who cannot edit Connections", () => {
    installAuthorizationGrantsForTests(
      WfGraphOperationIds.filter((id) => id !== "integration.update")
    );
    const view = renderFailure("Failed to send Slack message: invalid_auth", [
      connection,
    ]);

    expect(
      view.getByText(
        "Slack rejected the credentials of the Connection Acme Slack."
      )
    ).toBeTruthy();
    expect(view.queryByRole("button", { name: "Edit connection" })).toBeNull();
  });

  it("says the step's Connection was deleted", () => {
    installAuthorizationGrantsForTests(WfGraphOperationIds);
    const view = renderFailure(
      "Failed to send Slack message: invalid_auth",
      []
    );

    expect(
      view.getByText(
        "The Connection this step used was deleted. Choose another Connection on the step in Draft."
      )
    ).toBeTruthy();
    expect(view.queryByRole("button", { name: "Edit connection" })).toBeNull();
  });
});
