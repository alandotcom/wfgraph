import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { IntegrationSelector } from "#src/components/form-fields/integration-selector";
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
    },
  ],
};

/**
 * What the selector claims about the node it was handed.
 *
 * The claim is the whole of it: the pre-run check reads `integrationId` off the
 * node, so a selector reporting a connection the node does not name is a green
 * check over a workflow that refuses to run.
 */

function connection(id: string, name: string): Integration {
  return {
    id,
    name,
    type: "linear",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
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
          <OverlayProvider>
            <IntegrationSelector
              integrationType="linear"
              onChange={onChange}
              value={options.value}
            />
          </OverlayProvider>
        </JotaiProvider>
      </QueryClientProvider>
    </ExtensionCatalogProvider>
  );

  return { onChange };
}

describe("IntegrationSelector", () => {
  it("reports the sole connection as chosen only when the node names it", () => {
    renderSelector({
      value: undefined,
      connections: [connection("int_linear", "Linear Testing")],
    });

    expect(
      screen.getByRole("radio", { name: "Linear Testing" }).matches(":checked")
    ).toBe(false);
  });

  it("binds the node to the sole connection when it is clicked", () => {
    const { onChange } = renderSelector({
      value: undefined,
      connections: [connection("int_linear", "Linear Testing")],
    });

    fireEvent.click(screen.getByRole("radio", { name: "Linear Testing" }));

    expect(onChange).toHaveBeenCalledWith("int_linear");
  });

  it("reports the connection the node names", () => {
    renderSelector({
      value: "int_linear",
      connections: [connection("int_linear", "Linear Testing")],
    });

    expect(
      screen.getByRole("radio", { name: "Linear Testing" }).matches(":checked")
    ).toBe(true);
  });

  it("marks only the chosen one of several connections", () => {
    renderSelector({
      value: "int_second",
      connections: [
        connection("int_first", "First Linear"),
        connection("int_second", "Second Linear"),
      ],
    });

    expect(
      screen.getByRole("radio", { name: "First Linear" }).matches(":checked")
    ).toBe(false);
    expect(
      screen.getByRole("radio", { name: "Second Linear" }).matches(":checked")
    ).toBe(true);
  });
});
