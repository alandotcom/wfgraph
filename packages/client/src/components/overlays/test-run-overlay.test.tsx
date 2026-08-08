import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import {
  TestRunOverlay,
  type TestRunRequest,
} from "#src/components/overlays/test-run-overlay";
import { putExtensionCatalog } from "#src/lib/extensions";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { TestPayloads } from "@wfgraph/shared/lifecycle/test-payloads";

// The Events the overlay draws a form from come from the server's catalog. One
// declares a timestamp, which is the field the Wait node's target is written
// against, and the other is here so the select has two rows.
beforeEach(() => {
  putExtensionCatalog({
    events: [
      {
        name: "app/appointment.created",
        label: "Appointment created",
        correlationPath: "appointment.id",
        payloadFields: [
          { path: "appointment.id", type: "string" },
          {
            path: "appointment.startsAt",
            type: "timestamp",
          },
        ],
      },
      {
        name: "app/appointment.rescheduled",
        label: "Appointment rescheduled",
        payloadFields: [{ path: "appointment.id", type: "string" }],
      },
    ],
    actions: [],
    integrations: [],
  });
});

afterEach(() => {
  putExtensionCatalog(emptyExtensionCatalog);
});

const START_EVENTS = [
  "app/appointment.created",
  "app/appointment.rescheduled",
] as const;

function renderOverlay(
  overrides: {
    hasEventSplit?: boolean;
    allowManualStart?: boolean;
    savedPayloads?: TestPayloads;
  } = {}
) {
  const onRun = vi.fn<(request: TestRunRequest) => void>();

  render(
    <OverlayProvider>
      <TestRunOverlay
        allowManualStart={overrides.allowManualStart ?? true}
        hasEventSplit={overrides.hasEventSplit ?? false}
        onRun={onRun}
        overlayId="overlay-1"
        savedPayloads={overrides.savedPayloads ?? {}}
        startEvents={START_EVENTS}
      />
    </OverlayProvider>
  );

  return { onRun };
}

describe("TestRunOverlay", () => {
  it("opens on the first Start Event and draws its declared fields", () => {
    renderOverlay();

    expect(screen.getByText("Appointment created")).toBeTruthy();
    expect(screen.getByLabelText(/appointment\.id/)).toBeTruthy();
    expect(screen.getByLabelText(/appointment\.startsAt/)).toBeTruthy();
  });

  // The payload is the whole point: a run sent without one resolves every
  // downstream template to empty text.
  it("sends the Event and the payload the form holds", () => {
    const { onRun } = renderOverlay();

    fireEvent.change(screen.getByLabelText(/appointment\.id/), {
      target: { value: "appt_1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(onRun).toHaveBeenCalledWith({
      eventName: "app/appointment.created",
      input: { appointment: { id: "appt_1" } },
    });
  });

  it("opens on the payload the workflow kept for that Event", () => {
    renderOverlay({
      savedPayloads: {
        byEvent: {
          "app/appointment.created": { appointment: { id: "appt_saved" } },
        },
      },
    });

    expect(
      screen.getByLabelText<HTMLInputElement>(/appointment\.id/).value
    ).toBe("appt_saved");
  });

  // A graph that splits on the Event refuses an Event-less run, so the overlay
  // says so where the choice is made rather than after the request.
  it("says why a split graph takes no Event-less run", () => {
    renderOverlay({ hasEventSplit: true });

    expect(screen.getByText(/splits on the Event a run is on/)).toBeTruthy();
  });

  it("reports JSON it cannot read instead of sending it", () => {
    const { onRun } = renderOverlay();

    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    fireEvent.change(screen.getByLabelText("Payload JSON"), {
      target: { value: "{oops" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(screen.getByText("This is not valid JSON.")).toBeTruthy();
    expect(onRun).not.toHaveBeenCalled();
  });
});
