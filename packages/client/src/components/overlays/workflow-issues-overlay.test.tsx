import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  OverlayProvider,
  useOverlay,
} from "#src/components/overlays/overlay-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import { WorkflowIssuesOverlay } from "#src/components/overlays/workflow-issues-overlay";
import { hydrateExtensionsFromApi } from "#src/lib/extensions";
import type { Integration } from "#src/lib/rpc-client";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import {
  loadWorkflowGraphAtom,
  nodesAtom,
} from "#src/lib/workflow-graph-store";
import type { ExtensionCatalog } from "@rova/shared/extensions/catalog";
import type { WorkflowNode } from "@rova/shared/graph/types";

/**
 * The dialog offers to fix the missing connection it reports, and the fix has to
 * reach the graph. Creating the connection refreshes the list, which leaves
 * every flagged node's `integrationId` empty, so the same issue came back on the
 * next Run and no wording in the dialog explained why.
 */

const ACTION = "acuity/list-appointments";

// The credential form belongs to another suite. What matters here is what the
// dialog hands it and what happens when it reports a connection created.
vi.mock("#src/components/overlays/add-connection-overlay", () => ({
  ConfigureConnectionOverlay: ({
    onSuccess,
  }: {
    onSuccess?: (integrationId: string) => void;
  }) => (
    <button onClick={() => onSuccess?.("int_acuity")} type="button">
      create
    </button>
  ),
}));

const served: ExtensionCatalog = {
  events: [],
  actions: [
    {
      id: ACTION,
      label: "List Appointments",
      description: "List appointments with optional filters",
      category: "Acuity",
      integration: "acuity",
      configFields: [],
      outputFields: [],
    },
  ],
  integrations: [
    {
      type: "acuity",
      label: "Acuity",
      description: "Manage appointments in Acuity Scheduling",
      credentialFields: {},
      hasTest: true,
    },
  ],
};

beforeAll(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ catalog: served }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
    )
  );
  await hydrateExtensionsFromApi();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const connection: Integration = {
  id: "int_acuity",
  name: "Acuity Testing",
  type: "acuity",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const unboundNode: WorkflowNode = {
  id: "node_1",
  type: "action",
  position: { x: 0, y: 0 },
  data: {
    label: "Did they reschedule?",
    type: "action",
    config: { actionType: ACTION },
  },
};

/** Whatever the dialog pushed, rendered without the animated container. */
function OverlayStack() {
  const { stack } = useOverlay();
  return (
    <>
      {stack.map((item) => {
        const Pushed = item.component;
        return <Pushed key={item.id} overlayId={item.id} {...item.props} />;
      })}
    </>
  );
}

function renderIssues() {
  const store = createStore();
  store.set(loadWorkflowGraphAtom, { nodes: [unboundNode], edges: [] });

  // staleTime keeps the seeded list from being refetched over a network this
  // suite has none of. The repair reads it through `fetchQuery` either way.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(integrationsQueryOptions().queryKey, [connection]);

  render(
    <QueryClientProvider client={queryClient}>
      <JotaiProvider store={store}>
        <IntegrationUiProvider value={{}}>
          <OverlayProvider>
            <WorkflowIssuesOverlay
              issues={{
                brokenReferences: [],
                missingRequiredFields: [],
                missingIntegrations: [
                  {
                    integrationType: "acuity",
                    integrationLabel: "Acuity",
                    nodeNames: ["Did they reschedule?"],
                  },
                ],
              }}
              onGoToStep={vi.fn()}
              overlayId="overlay-1"
            />
            <OverlayStack />
          </OverlayProvider>
        </IntegrationUiProvider>
      </JotaiProvider>
    </QueryClientProvider>
  );

  return { config: () => store.get(nodesAtom)[0]?.data.config };
}

describe("WorkflowIssuesOverlay", () => {
  it("binds the flagged nodes to the connection its Add button created", async () => {
    const { config } = renderIssues();

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "create" }));

    await waitFor(() => expect(config()?.integrationId).toBe("int_acuity"));
  });
});
