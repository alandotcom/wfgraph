import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NodeConfigPatch } from "#src/components/workflow/config/node-config-patch";
import { WaitEventSelect } from "#src/components/workflow/config/wait-event-select";

/**
 * The picker takes its selection from the node config it is handed and its
 * vocabulary from the app's catalog, which is what lets a wait park on an Event
 * the workflow does not start on.
 */
vi.mock("#src/lib/extensions", () => ({
  getExtensionCatalog: () => ({
    events: [
      {
        name: "billing/payment.settled",
        label: "Payment settled",
        correlationPath: "invoice.id",
        payloadFields: [],
      },
      {
        name: "ops/nightly.swept",
        label: "Nightly sweep",
        payloadFields: [],
      },
    ],
    actions: [],
    integrations: [],
  }),
}));

function renderSelect(config: Record<string, unknown>) {
  const onUpdateConfig = vi.fn((_patch: NodeConfigPatch) => undefined);
  const view = render(
    <WaitEventSelect
      config={config}
      disabled={false}
      onUpdateConfig={onUpdateConfig}
    />
  );

  return {
    view,
    onUpdateConfig,
    /** The waitForEvents value of the most recent patch. */
    lastWaitForEvents: () =>
      onUpdateConfig.mock.calls.at(-1)?.[0].waitForEvents,
  };
}

describe("WaitEventSelect", () => {
  it("offers every Event the app declares", () => {
    const { view } = renderSelect({ waitForEvents: [] });

    expect(
      view.getByRole("button", { name: "billing/payment.settled" })
    ).toBeTruthy();
    expect(
      view.getByRole("button", { name: "ops/nightly.swept" })
    ).toBeTruthy();
  });

  it("writes an array rather than a joined string when selecting a chip", () => {
    const { view, lastWaitForEvents } = renderSelect({ waitForEvents: [] });

    fireEvent.click(
      view.getByRole("button", { name: "billing/payment.settled" })
    );
    expect(lastWaitForEvents()).toEqual(["billing/payment.settled"]);

    fireEvent.click(view.getByRole("button", { name: "ops/nightly.swept" }));
    // The component works from the config it was handed, which has not moved,
    // so the second click writes its own single-entry list.
    expect(lastWaitForEvents()).toEqual(["ops/nightly.swept"]);
    expect(Array.isArray(lastWaitForEvents())).toBe(true);
  });

  it("deselects a chip by writing the list without it", () => {
    const { view, onUpdateConfig, lastWaitForEvents } = renderSelect({
      waitForEvents: ["ops/nightly.swept"],
    });

    fireEvent.click(view.getByRole("button", { name: "ops/nightly.swept" }));

    expect(onUpdateConfig).toHaveBeenCalledTimes(1);
    expect(lastWaitForEvents()).toEqual([]);
  });

  // A host can send the bus an Event it never declared, so a name the catalog
  // does not carry stays selectable and stays visible -- with the consequence
  // said out loud, because nothing will arrive under it from this server.
  it("keeps a selection the catalog does not declare, and says so", () => {
    const { view } = renderSelect({ waitForEvents: ["vendor/thing.happened"] });

    const chip = view.getByRole("button", { name: "vendor/thing.happened" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(view.getByText(/declares no such Event/)).toBeTruthy();
  });

  it("adds a typed-in Event to the selection", () => {
    const { view, lastWaitForEvents } = renderSelect({ waitForEvents: [] });

    fireEvent.change(view.getByPlaceholderText("app/appointment.confirmed"), {
      target: { value: " vendor/thing.happened " },
    });
    fireEvent.click(view.getByRole("button", { name: "Add" }));

    expect(lastWaitForEvents()).toEqual(["vendor/thing.happened"]);
  });
});

// A wait subscribes to an Event on its own account: nothing here says what an
// Event does to a run, because that is the Lifecycle Node's declaration and the
// builder reads it there. What is left to warn about is a wait naming no Event,
// which nothing can wake.
describe("WaitEventSelect empty selection", () => {
  it("says a wait with no event named cannot be resumed", () => {
    const { view } = renderSelect({ waitForEvents: [] });

    expect(view.getByText(/Name at least one event/)).toBeTruthy();
  });

  it("stays quiet once an event is named", () => {
    const { view } = renderSelect({
      waitForEvents: ["billing/payment.settled"],
    });

    expect(view.queryByText(/Name at least one event/)).toBeNull();
  });
});
