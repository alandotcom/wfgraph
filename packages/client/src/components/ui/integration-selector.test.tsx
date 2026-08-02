import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { IntegrationSelector } from "#src/components/ui/integration-selector";
import type { Integration } from "#src/lib/rpc-client";
import { integrationsQueryOptions } from "#src/lib/rpc-query";

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
    type: "acuity",
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
    <QueryClientProvider client={queryClient}>
      <JotaiProvider store={createStore()}>
        <OverlayProvider>
          <IntegrationSelector
            integrationType="acuity"
            onChange={onChange}
            value={options.value}
          />
        </OverlayProvider>
      </JotaiProvider>
    </QueryClientProvider>
  );

  return { onChange };
}

describe("IntegrationSelector", () => {
  it("reports the sole connection as chosen only when the node names it", () => {
    renderSelector({
      value: undefined,
      connections: [connection("int_acuity", "Acuity Testing")],
    });

    expect(
      screen
        .getByRole("radio", { name: "Acuity Testing" })
        .getAttribute("aria-checked")
    ).toBe("false");
  });

  it("binds the node to the sole connection when it is clicked", () => {
    const { onChange } = renderSelector({
      value: undefined,
      connections: [connection("int_acuity", "Acuity Testing")],
    });

    fireEvent.click(screen.getByRole("radio", { name: "Acuity Testing" }));

    expect(onChange).toHaveBeenCalledWith("int_acuity");
  });

  it("reports the connection the node names", () => {
    renderSelector({
      value: "int_acuity",
      connections: [connection("int_acuity", "Acuity Testing")],
    });

    expect(
      screen
        .getByRole("radio", { name: "Acuity Testing" })
        .getAttribute("aria-checked")
    ).toBe("true");
  });

  it("marks only the chosen one of several connections", () => {
    renderSelector({
      value: "int_second",
      connections: [
        connection("int_first", "First Acuity"),
        connection("int_second", "Second Acuity"),
      ],
    });

    expect(
      screen
        .getByRole("radio", { name: "First Acuity" })
        .getAttribute("aria-checked")
    ).toBe("false");
    expect(
      screen
        .getByRole("radio", { name: "Second Acuity" })
        .getAttribute("aria-checked")
    ).toBe("true");
  });
});
