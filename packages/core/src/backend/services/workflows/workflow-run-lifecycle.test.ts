import { describe, expect, it } from "bun:test";
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

  it("falls back to the default event path when none is configured", () => {
    expect(
      buildIgnoredRunAuditMessage({
        triggerType: "webhook",
        reason: "missing_event_type",
      })
    ).toBe('Ignored webhook event: event type missing at path "event"');
  });

  it("names the unconfigured event when one arrived", () => {
    expect(
      buildIgnoredRunAuditMessage({
        triggerType: "webhook",
        reason: "event_not_configured",
        eventType: "order.archived",
      })
    ).toBe("Ignored webhook event order.archived");
    expect(
      buildIgnoredRunAuditMessage({
        triggerType: "webhook",
        reason: "event_not_configured",
      })
    ).toBe("Ignored webhook event not configured by routing");
  });

  it("explains that a stop event found nothing to stop", () => {
    expect(
      buildIgnoredRunAuditMessage({
        triggerType: "webhook",
        reason: "no_waiting_runs",
        eventType: "order.cancelled",
      })
    ).toBe("Ignored order.cancelled because no waiting runs were found");
    expect(
      buildIgnoredRunAuditMessage({
        triggerType: "manual",
        reason: "no_waiting_runs",
      })
    ).toBe("Ignored execute event because no waiting runs were found");
  });
});
