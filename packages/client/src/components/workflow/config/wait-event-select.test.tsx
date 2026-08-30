import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, type RenderResult } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { type ReactNode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import type { NodeConfigPatch } from "#src/components/workflow/config/node-config-patch";
import { WaitEventSelect } from "#src/components/workflow/config/wait-event-select";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import { loadWorkflowGraphAtom } from "#src/lib/workflow-graph-store";
import { parseConditionModel } from "@wfgraph/shared/conditions/conditions";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";

const testCatalog: ExtensionCatalog = {
  events: [
    {
      name: "billing/payment.settled",
      label: "Payment settled",
      correlationPath: "appointmentId",
      payloadFields: [
        { path: "appointmentId", description: "The appointment" },
        {
          path: "settledAt",
          description: "When it settled",
          type: "timestamp",
        },
      ],
    },
    {
      name: "ops/nightly.swept",
      label: "Nightly sweep",
      payloadFields: [],
    },
  ],
  actions: [],
  integrations: [],
};

type Subscription = { event: string; match?: string };

function renderSelect(config: Record<string, unknown>) {
  const onUpdateConfig = vi.fn((_patch: NodeConfigPatch) => undefined);
  const view = render(
    <ExtensionCatalogProvider value={testCatalog}>
      <WaitEventSelect
        config={config}
        disabled={false}
        onUpdateConfig={onUpdateConfig}
      />
    </ExtensionCatalogProvider>
  );

  return {
    view,
    onUpdateConfig,
    /** The waitFor value of the most recent patch. */
    lastWaitFor: () =>
      onUpdateConfig.mock.calls.at(-1)?.[0].waitFor as
        | Subscription[]
        | undefined,
  };
}

/** The graph the entry node's rules are read off, seeded the way the loader does. */
function withGraph(nodes: WorkflowNode[], children: ReactNode) {
  const store = createStore();
  store.set(loadWorkflowGraphAtom, { nodes, edges: [] });

  return (
    <ExtensionCatalogProvider value={testCatalog}>
      <JotaiProvider store={store}>{children}</JotaiProvider>
    </ExtensionCatalogProvider>
  );
}

function entryNode(correlationPaths: Record<string, string>): WorkflowNode {
  return {
    id: "lifecycle-1",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: {
      label: "Start",
      type: "lifecycle",
      config: {
        lifecycleRules: {
          startEvents: ["billing/payment.settled"],
          cancelEvents: [],
          concurrency: "unlimited",
          correlationPaths,
        },
      },
    },
  };
}

function renderSelectWithGraph(
  config: Record<string, unknown>,
  nodes: WorkflowNode[]
) {
  const onUpdateConfig = vi.fn((_patch: NodeConfigPatch) => undefined);
  const view = render(
    withGraph(
      nodes,
      <WaitEventSelect
        config={config}
        disabled={false}
        onUpdateConfig={onUpdateConfig}
      />
    )
  );

  return {
    view,
    onUpdateConfig,
    lastWaitFor: () =>
      onUpdateConfig.mock.calls.at(-1)?.[0].waitFor as
        | Subscription[]
        | undefined,
  };
}

/**
 * The select with its own writes fed back, which is what the editor does.
 *
 * The harness above is enough for a case about the patch a control emits; a
 * case about what the panel shows afterwards needs that patch to land.
 */
function renderControlledSelect(initialConfig: Record<string, unknown>) {
  function Controlled() {
    const [config, setConfig] = useState(initialConfig);

    return (
      <WaitEventSelect
        config={config}
        disabled={false}
        onUpdateConfig={(patch) =>
          setConfig((previous) => ({ ...previous, ...patch }))
        }
      />
    );
  }

  return render(withGraph([], <Controlled />));
}

/**
 * Search the picker and take the first Event it offers.
 *
 * The popup opens on an arrow key rather than a click: a pointer press reaches
 * the list through events happy-dom does not deliver whole, and the keyboard path
 * is the one a builder filtering a long list takes anyway.
 */
function chooseEvent(view: RenderResult, query: string) {
  const input = view.getByLabelText("Resume when the event is");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.change(input, { target: { value: query } });

  const option = view.getAllByRole("option").at(0);
  if (!option) {
    throw new Error(`No Event matched "${query}"`);
  }
  fireEvent.click(option);
}

describe("WaitEventSelect", () => {
  it("offers every Event the app declares", () => {
    const { view } = renderSelect({ waitFor: [] });

    const input = view.getByLabelText("Resume when the event is");
    fireEvent.keyDown(input, { key: "ArrowDown" });

    expect(
      view.getAllByRole("option").map((option) => option.textContent)
    ).toEqual([
      "Payment settledbilling/payment.settled",
      "Nightly sweepops/nightly.swept",
    ]);
  });

  it("adds a subscription with no match when an Event is chosen", () => {
    const { view, lastWaitFor } = renderSelect({ waitFor: [] });

    chooseEvent(view, "Payment settled");

    expect(lastWaitFor()).toEqual([{ event: "billing/payment.settled" }]);
  });

  // The raw name is what a sender posts, so a builder who knows only that half
  // still finds the Event.
  it("finds an Event by the name a sender posts", () => {
    const { view, lastWaitFor } = renderSelect({ waitFor: [] });

    chooseEvent(view, "ops/nightly");

    expect(lastWaitFor()).toEqual([{ event: "ops/nightly.swept" }]);
  });

  it("keeps the match already written when another Event is added", () => {
    const { view, lastWaitFor } = renderSelect({
      waitFor: [{ event: "billing/payment.settled", match: "{}" }],
    });

    chooseEvent(view, "Nightly sweep");

    expect(lastWaitFor()).toEqual([
      { event: "billing/payment.settled", match: "{}" },
      { event: "ops/nightly.swept" },
    ]);
  });

  it("drops a subscription when its row is removed", () => {
    const { view, onUpdateConfig, lastWaitFor } = renderSelect({
      waitFor: [{ event: "ops/nightly.swept" }],
    });

    fireEvent.click(
      view.getByRole("button", { name: "Remove ops/nightly.swept" })
    );

    expect(onUpdateConfig).toHaveBeenCalledTimes(1);
    expect(lastWaitFor()).toEqual([]);
  });
});

describe("WaitEventSelect match editor", () => {
  it("says what a subscription with no match means", () => {
    const { view } = renderSelect({
      waitFor: [{ event: "billing/payment.settled" }],
    });

    expect(
      view.getByText(/Any billing\/payment.settled resumes this run/)
    ).toBeTruthy();
  });

  // The common case, offered as one click: the arriving payload at this Event's
  // Correlation Path, with the right side left for the builder.
  it("seeds a match at the Event's Correlation Path", () => {
    const { view, lastWaitFor } = renderSelect({
      waitFor: [{ event: "billing/payment.settled" }],
    });

    fireEvent.click(view.getByRole("button", { name: "Add a match" }));

    const written = lastWaitFor()?.at(0);
    expect(written?.event).toBe("billing/payment.settled");

    const parsed = parseConditionModel(written?.match);
    expect(parsed.valid).toBe(true);
    if (parsed.valid) {
      expect(parsed.model.groups[0]?.conditions[0]?.field).toBe(
        "appointmentId"
      );
    }
  });

  // F2: this workflow's Correlation Path for the Event -- the entry node's
  // rules, resolved the same way the Lifecycle panel resolves them -- wins over
  // the Event Author's declaration, so the seed reads the field this workflow
  // actually correlates on rather than the one nothing here overrode.
  it("seeds a match at this workflow's overridden Correlation Path", () => {
    const { view, lastWaitFor } = renderSelectWithGraph(
      { waitFor: [{ event: "billing/payment.settled" }] },
      [entryNode({ "billing/payment.settled": "settledAt" })]
    );

    fireEvent.click(view.getByRole("button", { name: "Add a match" }));

    const parsed = parseConditionModel(lastWaitFor()?.at(0)?.match);
    expect(parsed.valid).toBe(true);
    if (parsed.valid) {
      expect(parsed.model.groups[0]?.conditions[0]?.field).toBe("settledAt");
    }
  });

  // The wait's vocabulary is the Event's own fields, so a timestamp field gets
  // timestamp operators rather than the string ones a free-typed path would.
  it("offers the Event's fields, typed, to the rule builder", () => {
    const { view } = renderSelect({
      waitFor: [
        {
          event: "billing/payment.settled",
          match: JSON.stringify({
            version: 2,
            groupLogic: "and",
            groups: [
              {
                id: "g",
                logic: "and",
                conditions: [
                  {
                    id: "r",
                    field: "settledAt",
                    fieldType: "timestamp",
                    operator: "before",
                    dateTime: "2026-07-01T00:00:00.000Z",
                  },
                ],
              },
            ],
          }),
        },
      ],
    });

    // The compiled expression is a detail of the editor rather than of the
    // rule, so it sits behind Edit with the controls it describes.
    fireEvent.click(view.getByRole("button", { name: "Edit Match" }));

    expect(view.getByText(/Compiled CEL/).textContent).toContain(
      'payload.settledAt < date("2026-07-01T00:00:00.000Z")'
    );
  });

  it("clears a match back to resuming on any occurrence", () => {
    const { view, lastWaitFor } = renderSelect({
      waitFor: [
        {
          event: "billing/payment.settled",
          match: JSON.stringify({
            version: 2,
            groupLogic: "and",
            groups: [
              {
                id: "g",
                logic: "and",
                conditions: [
                  {
                    id: "r",
                    field: "appointmentId",
                    fieldType: "string",
                    operator: "equals",
                    value: "appt_1",
                  },
                ],
              },
            ],
          }),
        },
      ],
    });

    fireEvent.click(
      view.getByRole("button", { name: /Resume on any billing/ })
    );

    expect(lastWaitFor()).toEqual([{ event: "billing/payment.settled" }]);
  });
});

// A wait subscribes to an Event on its own account: nothing here says what an
// Event does to a run, because that is the Lifecycle Node's declaration and the
// builder reads it there. What is left to warn about is a wait naming no Event,
// which nothing can wake.
describe("WaitEventSelect empty selection", () => {
  it("says a wait with no event named cannot be resumed", () => {
    const { view } = renderSelect({ waitFor: [] });

    expect(view.getByText(/Name at least one event/)).toBeTruthy();
  });

  it("stays quiet once an event is named", () => {
    const { view } = renderSelect({
      waitFor: [{ event: "billing/payment.settled" }],
    });

    expect(view.queryByText(/Name at least one event/)).toBeNull();
  });
});

describe("WaitEventSelect seeded match", () => {
  // The rule builder mounts the moment a match exists, and a seed leaves the
  // right side of the comparison empty. Landing on a summary of a rule nobody
  // has finished would make "Add a match" one click short of an editor.
  it("opens the rule builder on its controls after a seed", () => {
    const view = renderControlledSelect({
      waitFor: [{ event: "billing/payment.settled" }],
    });

    fireEvent.click(view.getByRole("button", { name: "Add a match" }));

    expect(view.getByLabelText("Select field")).toBeTruthy();
  });

  // A match loaded with the workflow is a rule already made, so it reads as one.
  it("opens a stored match in view mode", () => {
    const view = renderControlledSelect({
      waitFor: [
        {
          event: "billing/payment.settled",
          match: JSON.stringify({
            version: 2,
            groupLogic: "and",
            groups: [
              {
                id: "g",
                logic: "and",
                conditions: [
                  {
                    id: "r",
                    field: "appointmentId",
                    fieldType: "string",
                    operator: "equals",
                    value: "abc",
                  },
                ],
              },
            ],
          }),
        },
      ],
    });

    expect(view.queryByLabelText("Select field")).toBeNull();
    expect(view.getByText("1 condition")).toBeTruthy();
    expect(view.getByRole("button", { name: "Edit Match" })).toBeTruthy();
  });
});

const resendWaitCatalog: ExtensionCatalog = {
  events: [
    {
      name: "billing/payment.settled",
      label: "Payment settled",
      correlationPath: "appointmentId",
      payloadFields: [{ path: "appointmentId", type: "string" }],
    },
    {
      name: "resend/email.delivered",
      label: "Email delivered",
      integration: "resend",
      correlationPath: "data.email_id",
      payloadFields: [{ path: "data.email_id", type: "string" }],
    },
  ],
  actions: [],
  integrations: [
    {
      type: "resend",
      label: "Resend",
      description: "Send transactional emails",
      credentialFields: {},
      hasTest: true,
      hasWebhook: true,
    },
  ],
};

describe("WaitEventSelect Connection picker", () => {
  it("offers a Connection only for an integration-owned Event", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    queryClient.setQueryData(integrationsQueryOptions().queryKey, []);
    const onUpdateConfig = vi.fn();

    const view = render(
      <ExtensionCatalogProvider value={resendWaitCatalog}>
        <QueryClientProvider client={queryClient}>
          <JotaiProvider store={createStore()}>
            <OverlayProvider>
              <WaitEventSelect
                config={{
                  waitFor: [
                    { event: "billing/payment.settled" },
                    { event: "resend/email.delivered" },
                  ],
                }}
                disabled={false}
                onUpdateConfig={onUpdateConfig}
              />
            </OverlayProvider>
          </JotaiProvider>
        </QueryClientProvider>
      </ExtensionCatalogProvider>
    );

    expect(view.getByText("Payment settled")).toBeTruthy();
    expect(view.getByText("Email delivered")).toBeTruthy();
    expect(
      view.getByRole("button", { name: "Add Resend connection" })
    ).toBeTruthy();
    expect(
      view.queryByRole("button", { name: "Add Payment settled connection" })
    ).toBeNull();
  });
});
