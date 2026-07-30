import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import type { NodeConfigPatch } from "#src/components/workflow/config/node-config-patch";
import { WaitEventSelect } from "#src/components/workflow/config/wait-event-select";
import { loadWorkflowGraphAtom } from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "@rova/shared/workflow/types";

/**
 * The picker takes its selection from the node config it is handed, and its
 * vocabulary from the workflow's trigger node in the graph store. These seed
 * that store directly, the way the editor's loader does.
 */

function webhookTriggerNode(config: Record<string, unknown>): WorkflowNode {
  return {
    id: "trigger_1",
    type: "trigger",
    position: { x: 0, y: 0 },
    data: { label: "Trigger", type: "trigger", config },
  };
}

function renderSelect(options: {
  config: Record<string, unknown>;
  /** The graph the vocabulary is read from; empty means no trigger at all. */
  nodes?: WorkflowNode[];
}) {
  const store = createStore();
  store.set(loadWorkflowGraphAtom, {
    nodes: options.nodes ?? [],
    edges: [],
  });

  const onUpdateConfig = vi.fn((_patch: NodeConfigPatch) => undefined);
  const view = render(
    <JotaiProvider store={store}>
      <WaitEventSelect
        config={options.config}
        disabled={false}
        onUpdateConfig={onUpdateConfig}
      />
    </JotaiProvider>
  );

  return {
    view,
    onUpdateConfig,
    /** The waitForEvents value of the most recent patch. */
    lastWaitForEvents: () =>
      onUpdateConfig.mock.calls.at(-1)?.[0].waitForEvents,
  };
}

describe("WaitEventSelect with an open vocabulary", () => {
  // The webhook trigger's policy names only the events the builder mapped, so
  // a selection it does not mention is still a real choice and stays visible.
  it("renders a selection the trigger's policy never named", () => {
    const { view } = renderSelect({ config: { waitForEvents: ["x"] } });

    const chip = view.getByRole("button", { name: "x" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
  });

  it("deselects a chip by writing the list without it", () => {
    const { view, onUpdateConfig, lastWaitForEvents } = renderSelect({
      config: { waitForEvents: ["x"] },
    });

    fireEvent.click(view.getByRole("button", { name: "x" }));

    expect(onUpdateConfig).toHaveBeenCalledTimes(1);
    expect(lastWaitForEvents()).toEqual([]);
  });

  it("writes an array rather than a joined string when selecting a chip", () => {
    const { view, lastWaitForEvents } = renderSelect({
      config: { waitForEvents: [] },
      nodes: [
        webhookTriggerNode({
          triggerType: "Webhook",
          routingPolicy: { "a.b": "start", "c.d": "start" },
        }),
      ],
    });

    fireEvent.click(view.getByRole("button", { name: /^a\.b/ }));
    expect(lastWaitForEvents()).toEqual(["a.b"]);

    fireEvent.click(view.getByRole("button", { name: /^c\.d/ }));
    // The component works from the config it was handed, which has not moved,
    // so the second click writes its own single-entry list.
    expect(lastWaitForEvents()).toEqual(["c.d"]);
    expect(Array.isArray(lastWaitForEvents())).toBe(true);
  });
});

// A wait subscribes to an Event on its own account: nothing here says what an
// Event does to a run, because that is the Lifecycle Node's declaration and the
// builder reads it there. What is left to warn about is a wait naming no Event,
// which nothing can wake.
describe("WaitEventSelect empty selection", () => {
  it("says a wait with no event named cannot be resumed", () => {
    const { view } = renderSelect({
      config: { waitForEvents: [] },
      nodes: [webhookTriggerNode({ triggerType: "Webhook" })],
    });

    expect(view.getByText(/Name at least one event/)).toBeTruthy();
  });

  it("stays quiet once an event is named", () => {
    const { view } = renderSelect({
      config: { waitForEvents: ["a.b"] },
      nodes: [
        webhookTriggerNode({
          triggerType: "Webhook",
          routingPolicy: { "a.b": "ignore" },
        }),
      ],
    });

    expect(view.queryByText(/Name at least one event/)).toBeNull();
  });
});
