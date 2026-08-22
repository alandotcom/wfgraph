import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { ActionConfig } from "#src/components/workflow/config/action-config";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

const catalog: ExtensionCatalog = {
  events: [],
  integrations: [],
  actions: [
    {
      id: BUILT_IN_ACTION_IDS.condition,
      label: "Condition",
      description: "Branch based on a condition",
      category: "System",
      configFields: [],
      outputFields: [],
    },
  ],
};

describe("ActionConfig", () => {
  it("shows one field label inside the Condition section", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(integrationsQueryOptions().queryKey, []);

    const view = render(
      <QueryClientProvider client={queryClient}>
        <ExtensionCatalogProvider value={catalog}>
          <OverlayProvider>
            <ActionConfig
              config={{ actionType: BUILT_IN_ACTION_IDS.condition }}
              disabled={false}
              onUpdateConfig={vi.fn()}
            />
          </OverlayProvider>
        </ExtensionCatalogProvider>
      </QueryClientProvider>
    );

    const conditionFieldLabels = Array.from(
      view.container.querySelectorAll('[data-type="label"]')
    ).filter((label) => label.textContent === "Condition");
    expect(conditionFieldLabels).toHaveLength(1);
  });
});
