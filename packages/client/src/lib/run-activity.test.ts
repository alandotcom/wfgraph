import { describe, expect, it } from "vitest";
import { runActivitySentence } from "./run-activity";

const run = {
  startSource: "event" as const,
  startEventName: "app/appointment.created",
};

function sentence(
  event: { eventType: string; message: string; metadata?: unknown },
  runOverride: Partial<typeof run> | { startSource: "manual" | "schedule" } = {}
) {
  return runActivitySentence({
    event: { metadata: null, ...event },
    run: { ...run, ...runOverride },
    eventLabel: (name) =>
      name === "app/appointment.created" ? "Appointment created" : name,
    nodeName: (nodeId) =>
      nodeId === "wait_1" ? "Wait until 2 hours before" : null,
  });
}

describe("runActivitySentence", () => {
  it("words a run's start, end and park in the Runs view's terms", () => {
    expect(
      sentence({
        eventType: "run_started",
        message:
          "Event-triggered run of v2 started for app/appointment.created, to real recipients",
      })
    ).toBe("Started by Appointment created");
    expect(
      sentence(
        { eventType: "run_started", message: "x" },
        { startSource: "manual" }
      )
    ).toBe("Started manually");
    expect(
      sentence({
        eventType: "run_failed",
        message: "Run completed with errors",
      })
    ).toBe("Run failed");
    expect(
      sentence({
        eventType: "run_completed",
        message: "Run completed successfully (test recipients)",
      })
    ).toBe("Run completed");
    expect(
      sentence({
        eventType: "run_waiting",
        message: "Run waiting in delay node 'Wait until 2 hours before'",
        metadata: { nodeId: "wait_1" },
      })
    ).toBe("Waiting at Wait until 2 hours before");
  });

  it("keeps the stored sentence of an entry it does not reword", () => {
    expect(
      sentence({
        eventType: "run_resumed",
        message: "Run resumed from the Runs view",
      })
    ).toBe("Run resumed from the Runs view");
    expect(
      sentence({
        eventType: "run_waiting",
        message: "Run waiting in event node 'Approval'",
        metadata: { nodeId: "gone" },
      })
    ).toBe("Run waiting in event node 'Approval'");
  });
});
