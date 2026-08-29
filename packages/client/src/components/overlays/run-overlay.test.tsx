import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import {
  RunOverlay,
  type RunRequest,
} from "#src/components/overlays/run-overlay";
import type { WorkflowRunTarget } from "#src/lib/workflow-run-labels";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { TestPayloads } from "@wfgraph/shared/lifecycle/test-payloads";

const testCatalog: ExtensionCatalog = {
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
};

const START_EVENTS = [
  "app/appointment.created",
  "app/appointment.rescheduled",
] as const;

function renderOverlay(
  overrides: {
    hasEventSplit?: boolean;
    allowManualStart?: boolean;
    savedPayloads?: TestPayloads;
    target?: WorkflowRunTarget;
  } = {}
) {
  const onRun = vi.fn<(request: RunRequest) => void>();

  render(
    <ExtensionCatalogProvider value={testCatalog}>
      <OverlayProvider>
        <RunOverlay
          allowManualStart={overrides.allowManualStart ?? true}
          hasEventSplit={overrides.hasEventSplit ?? false}
          onRun={onRun}
          overlayId="overlay-1"
          savedPayloads={overrides.savedPayloads ?? {}}
          startEvents={START_EVENTS}
          target={overrides.target ?? { graph: "draft" }}
        />
      </OverlayProvider>
    </ExtensionCatalogProvider>
  );

  return { onRun };
}

describe("RunOverlay", () => {
  /**
   * One component, three headings. The Event and payload halves are identical
   * for each verb; what changes is the sentence saying which graph runs and who
   * receives what it sends.
   */
  it("says a draft run goes to test recipients while the published version keeps working", () => {
    renderOverlay({ target: { graph: "draft", publishedVersion: 7 } });

    expect(screen.getByRole("heading", { name: "Run draft" })).toBeTruthy();
    expect(
      screen.getByText(
        "Runs the draft on this canvas with test recipients. Published v7 keeps handling Events."
      )
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run draft" })).toBeTruthy();
  });

  it("warns a live published run where it sends", () => {
    renderOverlay({
      target: { graph: "published", publishedVersion: 7, workflowMode: "live" },
    });

    expect(screen.getByRole("heading", { name: "Run v7 · Live" })).toBeTruthy();
    expect(
      screen.getByText(
        "Runs Published v7 and sends to real recipients. Draft edits are not included."
      )
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run v7 · Live" })).toBeTruthy();
  });

  it("names test recipients on a published run in Test Published mode", () => {
    renderOverlay({
      target: { graph: "published", publishedVersion: 7, workflowMode: "test" },
    });

    expect(
      screen.getByText(
        "Runs Published v7 with test recipients. Draft edits are not included."
      )
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run v7 · Test" })).toBeTruthy();
  });

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
    fireEvent.click(screen.getByRole("button", { name: "Run draft" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Run draft" }));

    expect(screen.getByText("This is not valid JSON.")).toBeTruthy();
    expect(onRun).not.toHaveBeenCalled();
  });
});
