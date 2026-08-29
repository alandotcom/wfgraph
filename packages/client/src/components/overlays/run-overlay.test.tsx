import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import {
  RunOverlay,
  type RunRequest,
} from "#src/components/overlays/run-overlay";
import type { RunSends, WorkflowRunTarget } from "#src/lib/workflow-run-labels";
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
    sends?: RunSends;
    startEvents?: readonly string[];
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
          sends={overrides.sends ?? { count: 0, integrations: [] }}
          startEvents={overrides.startEvents ?? START_EVENTS}
          target={overrides.target ?? { graph: "draft" }}
        />
      </OverlayProvider>
    </ExtensionCatalogProvider>
  );

  return { onRun };
}

/** A published run of v7 in the given Published mode, which the sends band reads. */
function publishedTarget(workflowMode: "live" | "test"): WorkflowRunTarget {
  return { graph: "published", publishedVersion: 7, workflowMode };
}

describe("RunOverlay", () => {
  /**
   * One component with three headings. The Event and payload halves are the
   * same for every run command. What changes is the sentence naming which graph
   * runs and who receives what it sends.
   */
  it("states that a draft run reaches test recipients", () => {
    renderOverlay({ target: { graph: "draft" } });

    expect(screen.getByRole("heading", { name: "Run draft" })).toBeTruthy();
    expect(
      screen.getByText("Runs the draft on this canvas with test recipients.")
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run draft" })).toBeTruthy();
    expect(screen.queryByText(/sends?:/)).toBeNull();
  });

  /**
   * A live published run is the only run that reaches real recipients. The band
   * counts the sends in the published graph, and the button names the
   * consequence instead of the version number.
   */
  it("states the sends a live published run makes", () => {
    renderOverlay({
      sends: { count: 3, integrations: ["Slack", "Resend"] },
      target: publishedTarget("live"),
    });

    expect(
      screen.getByRole("heading", { name: "Run Published v7" })
    ).toBeTruthy();
    expect(screen.getByText("3 sends: Slack, Resend")).toBeTruthy();
    const confirm = screen.getByRole("button", {
      name: "Send to real recipients",
    });
    expect(confirm.className).toContain("destructive");
  });

  it("hides the sends band for a published run in Test Published mode", () => {
    renderOverlay({
      sends: { count: 3, integrations: ["Slack", "Resend"] },
      target: publishedTarget("test"),
    });

    expect(
      screen.getByRole("heading", { name: "Run Published v7" })
    ).toBeTruthy();
    expect(
      screen.getByText("Runs Published v7 with test recipients.")
    ).toBeTruthy();
    expect(screen.queryByText("3 sends: Slack, Resend")).toBeNull();
    expect(screen.getByRole("button", { name: "Run v7 · Test" })).toBeTruthy();
  });

  // A manual-only workflow has one way to start, so there is no choice to
  // offer between a manual start and a Start Event.
  it("hides the Event select for a manual-only workflow", () => {
    const { onRun } = renderOverlay({
      allowManualStart: true,
      startEvents: [],
    });

    expect(screen.queryByLabelText(/Which Event/)).toBeNull();
    // With no select above it, the payload note cannot say "this Event".
    expect(
      screen.getByText(/stands in for no Event has no declared field/)
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Run draft" }));
    expect(onRun).toHaveBeenCalledWith({ input: {} });
  });

  it("opens on the first Start Event and draws its declared fields", () => {
    renderOverlay();

    expect(screen.getByText("Appointment created")).toBeTruthy();
    expect(screen.getByLabelText(/appointment\.id/)).toBeTruthy();
    expect(screen.getByLabelText(/appointment\.startsAt/)).toBeTruthy();
  });

  // A run sent without a payload resolves every downstream template to empty
  // text.
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

  // A graph that splits on the Event rejects an Event-less run, so the overlay
  // reports that where the choice is made rather than after the request.
  it("explains why a split graph accepts no Event-less run", () => {
    renderOverlay({ hasEventSplit: true });

    expect(screen.getByText(/splits on the Event a run is on/)).toBeTruthy();
  });

  // A manual-only graph hides the Event block. Mid-build, with a split and no
  // Start Events declared yet, that would also hide the one sentence saying why
  // Run is disabled.
  it("keeps the Event block on a manual-only graph that has a split", () => {
    renderOverlay({
      hasEventSplit: true,
      allowManualStart: true,
      startEvents: [],
    });

    expect(screen.getByText(/splits on the Event a run is on/)).toBeTruthy();
  });

  it("reports invalid JSON instead of sending it", () => {
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
