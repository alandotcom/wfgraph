import { describe, expect, it } from "vitest";
import {
  buildIgnoredRunAuditMessage,
  buildRunStartedAuditMessage,
} from "./workflow-run-lifecycle";

describe("buildRunStartedAuditMessage", () => {
  it("names the entrypoint that started the run", () => {
    expect(
      buildRunStartedAuditMessage({ triggerType: "manual", runMode: "live" })
    ).toBe("Manual run started");
    expect(
      buildRunStartedAuditMessage({ triggerType: "webhook", runMode: "live" })
    ).toBe("Webhook run started");
    expect(
      buildRunStartedAuditMessage({ triggerType: "event", runMode: "live" })
    ).toBe("Event-triggered run started");
  });

  it("marks test mode runs", () => {
    expect(
      buildRunStartedAuditMessage({ triggerType: "webhook", runMode: "test" })
    ).toBe("Webhook test mode run started");
  });

  it("appends the event type when the trigger resolved one", () => {
    expect(
      buildRunStartedAuditMessage({
        triggerType: "event",
        runMode: "test",
        eventType: "order.created",
      })
    ).toBe("Event-triggered test mode run started for order.created");
  });
});

describe("buildIgnoredRunAuditMessage", () => {
  it("uses the calling entrypoint's own vocabulary", () => {
    expect(
      buildIgnoredRunAuditMessage({
        triggerType: "manual",
        reason: "workflow_paused",
      })
    ).toBe("Ignored execute event because workflow is paused");
    expect(
      buildIgnoredRunAuditMessage({
        triggerType: "webhook",
        reason: "workflow_paused",
      })
    ).toBe("Ignored webhook event because workflow is paused");
    expect(
      buildIgnoredRunAuditMessage({
        triggerType: "event",
        reason: "workflow_paused",
      })
    ).toBe("Ignored event because workflow is paused");
  });

  it("reports where the event type was expected", () => {
    expect(
      buildIgnoredRunAuditMessage({
        triggerType: "webhook",
        reason: "missing_event_type",
        eventTypePath: "body.type",
      })
    ).toBe('Ignored webhook event: event type missing at path "body.type"');
  });

  // No path is fabricated when none is known: a default would send the
  // builder to fix a field the classifier never reads.
  it("omits the path when none is configured", () => {
    expect(
      buildIgnoredRunAuditMessage({
        triggerType: "webhook",
        reason: "missing_event_type",
      })
    ).toBe("Ignored webhook event: no event type was found in the payload");
  });

  it("says the payload failed the trigger schema", () => {
    expect(
      buildIgnoredRunAuditMessage({
        triggerType: "webhook",
        reason: "invalid_payload",
      })
    ).toBe("Ignored webhook event: payload failed the trigger schema");
  });

  it("names the event the routing policy does not map", () => {
    expect(
      buildIgnoredRunAuditMessage({
        triggerType: "webhook",
        reason: "event_not_mapped",
        eventType: "order.archived",
      })
    ).toBe(
      "Ignored webhook event order.archived: not mapped by the routing policy"
    );
    expect(
      buildIgnoredRunAuditMessage({
        triggerType: "webhook",
        reason: "event_not_mapped",
      })
    ).toBe("Ignored webhook event: not mapped by the routing policy");
  });

  it("explains that a cancel event found nothing to cancel", () => {
    expect(
      buildIgnoredRunAuditMessage({
        triggerType: "webhook",
        reason: "no_in_flight_runs",
        eventType: "order.cancelled",
      })
    ).toBe("Ignored order.cancelled because no in-flight runs were found");
    expect(
      buildIgnoredRunAuditMessage({
        triggerType: "manual",
        reason: "no_in_flight_runs",
      })
    ).toBe("Ignored execute event because no in-flight runs were found");
  });
});
