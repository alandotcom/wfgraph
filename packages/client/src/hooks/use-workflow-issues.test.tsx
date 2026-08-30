/**
 * The two things the collection hook must not do while the connection list is
 * still in flight: accuse sound nodes, and re-render forever.
 *
 * Both came from defaulting the query to `[]`. An empty list is a real answer
 * ("this operator has no connections"), and using it for "not asked yet" made
 * every configured node look broken; the fresh literal behind it also changed
 * the memo key on every render, which closed a loop through the atom and back
 * into this hook.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { createStore, Provider, useAtomValue } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { useCollectWorkflowIssues } from "#src/hooks/use-workflow-issues";
import { loadWorkflowGraphAtom } from "#src/lib/workflow-graph-store";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";

const catalog: ExtensionCatalog = {
  events: [],
  integrations: [
    {
      type: "slack",
      label: "Slack",
      description: "Slack",
      credentialFields: {},
      hasTest: false,
      hasWebhook: false,
    },
  ],
  actions: [
    {
      id: "custom/send",
      label: "Send Message",
      description: "Sends a message",
      category: "Custom",
      integration: "slack",
      configFields: [],
      outputFields: [],
    },
  ],
};

/** One action, fully configured against a connection the operator holds. */
const soundGraph: WorkflowNode[] = [
  {
    id: "t",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: { label: "Start", type: "lifecycle" },
  },
  {
    id: "a",
    type: "action",
    position: { x: 0, y: 200 },
    data: {
      label: "Notify",
      type: "action",
      config: { actionType: "custom/send", integrationId: "int_1" },
    },
  },
];

function renderHarness() {
  const store = createStore();
  store.set(loadWorkflowGraphAtom, { nodes: soundGraph, edges: [] });

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });

  let renders = 0;
  const seen: number[] = [];

  function Harness() {
    renders += 1;
    useCollectWorkflowIssues();
    seen.push(useAtomValue(workflowIssuesAtom).length);
    return null;
  }

  render(
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>
        <ExtensionCatalogProvider value={catalog}>
          <Harness />
        </ExtensionCatalogProvider>
      </Provider>
    </QueryClientProvider>
  );

  return { renderCount: () => renders, seen, store };
}

describe("useCollectWorkflowIssues", () => {
  // The query brings its own `queryFn`, so a default on the client cannot hold
  // it open. Stubbing fetch with a promise that never settles pins `data` to
  // `undefined` for the whole test: no network, no timing race, and no way for
  // the assertions below to pass by accident.
  beforeEach(() => {
    vi.stubGlobal("fetch", () => new Promise(() => undefined));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accuses nothing while the connection list is still in flight", async () => {
    const harness = renderHarness();

    // Give the debounce and any pending effects room to land.
    await waitFor(() => expect(harness.renderCount()).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(harness.store.get(workflowIssuesAtom)).toEqual([]);
    expect(harness.seen.every((count) => count === 0)).toBe(true);
  });

  it("settles instead of re-rendering without bound", async () => {
    const harness = renderHarness();

    await new Promise((resolve) => setTimeout(resolve, 400));
    const settled = harness.renderCount();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The old shape grew this without limit until React threw "Maximum update
    // depth exceeded". A handful of commits is the debounce, not a loop.
    expect(harness.renderCount()).toBe(settled);
    expect(settled).toBeLessThan(10);
  });
});
