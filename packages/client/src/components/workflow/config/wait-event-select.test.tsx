import {
  fireEvent,
  render,
  type RenderResult,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NodeConfigPatch } from "#src/components/workflow/config/node-config-patch";
import { WaitEventSelect } from "#src/components/workflow/config/wait-event-select";
import { parseConditionModel } from "@rova/shared/workflow/conditions";

/**
 * The picker takes its subscriptions from the node config it is handed and its
 * vocabulary from the app's catalog, which is what lets a wait park on an Event
 * the workflow does not start on. The match editor's vocabulary is then the
 * chosen Event's own payload fields.
 */
vi.mock("#src/lib/extensions", () => ({
  getExtensionCatalog: () => ({
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
  }),
}));

type Subscription = { event: string; match?: string };

/** An Event name is a path, and a regex over it has to read it literally. */
const SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

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
    /** The waitFor value of the most recent patch. */
    lastWaitFor: () =>
      onUpdateConfig.mock.calls.at(-1)?.[0].waitFor as
        | Subscription[]
        | undefined,
  };
}

/**
 * The chip for one Event. A chip reads as its label over its raw name, so the
 * name alone no longer picks one out by accessible name.
 */
function eventChip(view: RenderResult, eventName: string): HTMLElement {
  return within(view.getByRole("group")).getByRole("button", {
    name: new RegExp(eventName.replace(SPECIAL_CHARS, "\\$&")),
  });
}

describe("WaitEventSelect", () => {
  it("offers every Event the app declares", () => {
    const { view } = renderSelect({ waitFor: [] });

    expect(eventChip(view, "billing/payment.settled").textContent).toContain(
      "Payment settled"
    );
    expect(eventChip(view, "ops/nightly.swept").textContent).toContain(
      "Nightly sweep"
    );
  });

  it("adds a subscription with no match when a chip is chosen", () => {
    const { view, lastWaitFor } = renderSelect({ waitFor: [] });

    fireEvent.click(eventChip(view, "billing/payment.settled"));

    expect(lastWaitFor()).toEqual([{ event: "billing/payment.settled" }]);
  });

  it("deselects a chip by writing the list without it", () => {
    const { view, onUpdateConfig, lastWaitFor } = renderSelect({
      waitFor: [{ event: "ops/nightly.swept" }],
    });

    fireEvent.click(eventChip(view, "ops/nightly.swept"));

    expect(onUpdateConfig).toHaveBeenCalledTimes(1);
    expect(lastWaitFor()).toEqual([]);
  });

  // A host can send the bus an Event it never declared, so a name the catalog
  // does not carry stays selectable and stays visible -- with the consequence
  // said out loud, because this server knows none of its fields.
  it("keeps a subscription the catalog does not declare, and says so", () => {
    const { view } = renderSelect({
      waitFor: [{ event: "vendor/thing.happened" }],
    });

    const chip = eventChip(view, "vendor/thing.happened");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(view.getByText(/declares no such Event/)).toBeTruthy();
  });

  it("adds a typed-in Event to the subscriptions", () => {
    const { view, lastWaitFor } = renderSelect({ waitFor: [] });

    fireEvent.change(view.getByPlaceholderText("app/appointment.confirmed"), {
      target: { value: " vendor/thing.happened " },
    });
    fireEvent.click(view.getByRole("button", { name: "Add" }));

    expect(lastWaitFor()).toEqual([{ event: "vendor/thing.happened" }]);
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
