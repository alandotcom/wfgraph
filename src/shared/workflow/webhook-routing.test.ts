import { describe, expect, it } from "bun:test";
import {
  buildWebhookRoutingConfig,
  deriveWebhookEventContext,
  routeWebhookEvent,
} from "./webhook-routing";

describe("buildWebhookRoutingConfig", () => {
  it("uses defaults when trigger config is missing", () => {
    const routing = buildWebhookRoutingConfig(undefined);

    expect(routing.eventTypePath).toBe("event");
    expect(routing.correlationPath).toBe("data.id");
    expect(routing.createEvents).toEqual(new Set(["event.create"]));
    expect(routing.updateEvents).toEqual(new Set(["event.update"]));
    expect(routing.deleteEvents).toEqual(new Set(["event.delete"]));
    expect(routing.routingConfigured).toBe(true);
  });

  it("parses webhook trigger config values", () => {
    const routing = buildWebhookRoutingConfig({
      triggerType: "Webhook",
      webhookEventPath: " payload.type ",
      webhookCorrelationPath: " payload.data.id ",
      webhookCreateEvents: "entity.created, entity.inserted",
      webhookUpdateEvents: "entity.updated",
      webhookDeleteEvents: "entity.deleted",
    });

    expect(routing.eventTypePath).toBe("payload.type");
    expect(routing.correlationPath).toBe("payload.data.id");
    expect(routing.createEvents).toEqual(
      new Set(["entity.created", "entity.inserted"])
    );
    expect(routing.updateEvents).toEqual(new Set(["entity.updated"]));
    expect(routing.deleteEvents).toEqual(new Set(["entity.deleted"]));
    expect(routing.routingConfigured).toBe(true);
  });

  it("marks routing as not configured when all event lists are empty", () => {
    const routing = buildWebhookRoutingConfig({
      triggerType: "Webhook",
      webhookCreateEvents: "",
      webhookUpdateEvents: "",
      webhookDeleteEvents: "",
    });

    expect(routing.createEvents.size).toBe(0);
    expect(routing.updateEvents.size).toBe(0);
    expect(routing.deleteEvents.size).toBe(0);
    expect(routing.routingConfigured).toBe(false);
  });
});

describe("deriveWebhookEventContext", () => {
  it("extracts eventType and correlationKey from configured paths", () => {
    const routing = buildWebhookRoutingConfig({
      triggerType: "Webhook",
      webhookEventPath: "payload.type",
      webhookCorrelationPath: "payload.data.id",
    });

    const context = deriveWebhookEventContext(
      {
        payload: {
          type: " entity.updated ",
          data: {
            id: " abc-123 ",
          },
        },
      },
      routing
    );

    expect(context).toEqual({
      eventType: "entity.updated",
      correlationKey: "abc-123",
    });
  });
});

describe("routeWebhookEvent", () => {
  it("ignores when event type is missing but routing is configured", () => {
    const routing = buildWebhookRoutingConfig({
      triggerType: "Webhook",
    });

    expect(
      routeWebhookEvent({
        eventType: undefined,
        routing,
      })
    ).toEqual({ kind: "ignore", reason: "missing_event_type" });
  });

  it("routes delete and update events before create matching", () => {
    const routing = buildWebhookRoutingConfig({
      triggerType: "Webhook",
      webhookCreateEvents: "entity.changed",
      webhookUpdateEvents: "entity.changed, entity.updated",
      webhookDeleteEvents: "entity.deleted, entity.changed",
    });

    expect(
      routeWebhookEvent({
        eventType: "entity.deleted",
        routing,
      })
    ).toEqual({ kind: "delete" });

    expect(
      routeWebhookEvent({
        eventType: "entity.updated",
        routing,
      })
    ).toEqual({ kind: "update" });

    expect(
      routeWebhookEvent({
        eventType: "entity.changed",
        routing,
      })
    ).toEqual({ kind: "delete" });
  });

  it("ignores configured create mismatch events", () => {
    const routing = buildWebhookRoutingConfig({
      triggerType: "Webhook",
      webhookCreateEvents: "entity.created",
      webhookUpdateEvents: "",
      webhookDeleteEvents: "",
    });

    expect(
      routeWebhookEvent({
        eventType: "entity.unknown",
        routing,
      })
    ).toEqual({ kind: "ignore", reason: "event_not_configured" });
  });

  it("defaults to create when create events are unrestricted", () => {
    const routing = buildWebhookRoutingConfig({
      triggerType: "Webhook",
      webhookCreateEvents: "",
      webhookUpdateEvents: "",
      webhookDeleteEvents: "",
    });

    expect(
      routeWebhookEvent({
        eventType: "entity.anything",
        routing,
      })
    ).toEqual({ kind: "create" });
  });
});
