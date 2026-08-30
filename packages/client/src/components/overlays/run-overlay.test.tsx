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

/** A published run of v7 in the given Published mode, which the sends line reads. */
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
      screen.getByText("Runs the draft and sends to test recipients.")
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run draft" })).toBeTruthy();
    expect(screen.queryByText(/reaches? outside this workflow/)).toBeNull();
  });

  /**
   * A live published run is the only run that reaches real recipients, so it is
   * the only one that counts what the version sends. The dialog wears the
   * default style either way: the sentence carries the difference.
   */
  it("counts the steps a live published run sends outward", () => {
    renderOverlay({
      sends: { count: 3, integrations: ["Slack", "Resend"] },
      target: publishedTarget("live"),
    });

    expect(screen.getByRole("heading", { name: "Run v7" })).toBeTruthy();
    expect(
      screen.getByText("Runs v7 and sends to real recipients.")
    ).toBeTruthy();
    expect(
      screen.getByText("3 steps reach outside this workflow: Slack, Resend")
    ).toBeTruthy();
    // The default ink, so the dialog reads as a run rather than a deletion.
    const confirm = screen.getByRole("button", { name: "Run v7" });
    expect(confirm.className).toContain("bg-primary");
    expect(confirm.className).not.toContain("bg-destructive");
  });

  it("hides the sends line for a published run in Test Published mode", () => {
    renderOverlay({
      sends: { count: 3, integrations: ["Slack", "Resend"] },
      target: publishedTarget("test"),
    });

    expect(screen.getByRole("heading", { name: "Run v7" })).toBeTruthy();
    expect(
      screen.getByText("Runs v7 and sends to test recipients.")
    ).toBeTruthy();
    expect(
      screen.queryByText("3 steps reach outside this workflow: Slack, Resend")
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Run v7" })).toBeTruthy();
  });

  // A manual-only workflow has one way to start, so there is no choice to
  // offer between a manual start and a Start Event.
  it("hides the Event select for a manual-only workflow", () => {
    const { onRun } = renderOverlay({
      allowManualStart: true,
      startEvents: [],
    });

    expect(screen.queryByLabelText("Event")).toBeNull();
    // With no select above it, the payload note cannot say "this Event".
    expect(
      screen.getByText(/This run has no Event, so there are no form fields/)
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

    expect(screen.getByText(/This workflow has an Event Split/)).toBeTruthy();
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

    expect(screen.getByText(/This workflow has an Event Split/)).toBeTruthy();
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
