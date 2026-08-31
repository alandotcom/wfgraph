import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationSelector } from "#src/components/ui/integration-selector";
import type { Integration } from "#src/lib/rpc-client";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

const testCatalog: ExtensionCatalog = {
  events: [],
  actions: [],
  integrations: [
    {
      type: "linear",
      label: "Linear",
      description: "Linear issue tracking",
      credentialFields: {},
      hasTest: true,
      hasWebhook: false,
    },
  ],
};

/** The one control the selector renders, named for the integration it serves. */
function trigger(): HTMLElement {
  return screen.getByRole("combobox", { name: "Linear connection" });
}

function connection(id: string, name: string): Integration {
  return {
    id,
    name,
    type: "linear",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    configuredKeys: [],
    connectionDefaults: {},
  };
}

function renderSelector(options: {
  value?: string;
  connections: Integration[];
}) {
  const onChange = vi.fn<(integrationId: string) => void>();

  // staleTime keeps the seeded list from being refetched over a network this
  // suite has none of.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(
    integrationsQueryOptions().queryKey,
    options.connections
  );

  render(
    <ExtensionCatalogProvider value={testCatalog}>
      <QueryClientProvider client={queryClient}>
        <JotaiProvider store={createStore()}>
          <IntegrationSelector
            integrationType="linear"
            onChange={onChange}
            value={options.value}
          />
        </JotaiProvider>
      </QueryClientProvider>
    </ExtensionCatalogProvider>
  );

  return { onChange };
}

describe("IntegrationSelector", () => {
  it("names no connection until the node names one", () => {
    renderSelector({
      value: undefined,
      connections: [connection("int_linear", "Linear Testing")],
    });

    // The claim is the whole of it: the pre-run check reads `integrationId` off
    // the node, so a trigger reading back a connection the node does not name
    // is a bound-looking step over a workflow that refuses to run.
    expect(trigger().textContent).toContain("Choose a connection");
  });

  it("reads back the connection the node names", () => {
    renderSelector({
      value: "int_linear",
      connections: [connection("int_linear", "Linear Testing")],
    });

    expect(trigger().textContent).toContain("Linear Testing");
  });

  it("binds the node to the connection that was picked", () => {
    const { onChange } = renderSelector({
      value: undefined,
      connections: [
        connection("int_first", "First Linear"),
        connection("int_second", "Second Linear"),
      ],
    });

    fireEvent.click(trigger());
    const choice = screen.getByRole("option", { name: "Second Linear" });
    fireEvent.pointerDown(choice);
    fireEvent.click(choice);

    expect(onChange).toHaveBeenCalledWith("int_second");
  });

  it("offers every connection of the integration", () => {
    renderSelector({
      value: "int_first",
      connections: [
        connection("int_first", "First Linear"),
        connection("int_second", "Second Linear"),
      ],
    });

    fireEvent.click(trigger());

    expect(
      screen.getAllByRole("option").map((option) => option.textContent)
    ).toEqual(["First Linear", "Second Linear"]);
  });

  it("sends a builder to Settings when the integration has no connection", () => {
    renderSelector({ value: undefined, connections: [] });

    // Creating a connection belongs to Settings > Connections, so the empty
    // state names that route rather than offering a second way to do it.
    expect(trigger().textContent).toContain("No connection");
    expect(
      screen.getByText(/Add a Linear connection in Settings > Connections\./)
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add/u })).toBeNull();
  });
});
