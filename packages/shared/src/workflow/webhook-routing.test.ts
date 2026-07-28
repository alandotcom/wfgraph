import { describe, expect, it } from "vitest";
import {
  buildWebhookRoutingConfig,
  deriveWebhookEventContext,
} from "./webhook-routing";

describe("buildWebhookRoutingConfig", () => {
  it("uses defaults when trigger config is missing", () => {
    expect(buildWebhookRoutingConfig(undefined)).toEqual({
      eventTypePath: "event",
      correlationPath: "data.id",
    });
  });

  it("parses and trims the builder-supplied paths", () => {
    expect(
      buildWebhookRoutingConfig({
        triggerType: "Webhook",
        webhookEventPath: " payload.type ",
        webhookCorrelationPath: " payload.data.id ",
      })
    ).toEqual({
      eventTypePath: "payload.type",
      correlationPath: "payload.data.id",
    });
  });

  it("falls back to the defaults path by path when one is blank", () => {
    expect(
      buildWebhookRoutingConfig({
        triggerType: "Webhook",
        webhookEventPath: "   ",
        webhookCorrelationPath: "payload.data.id",
      })
    ).toEqual({
      eventTypePath: "event",
      correlationPath: "payload.data.id",
    });
  });

  // A config the schema rejects still has to yield something usable, since the
  // webhook keeps receiving payloads while the builder is mid-edit.
  it("falls back to defaults when the config does not parse", () => {
    expect(
      buildWebhookRoutingConfig({
        triggerType: "Webhook",
        unknownKey: "payload.type",
      })
    ).toEqual({
      eventTypePath: "event",
      correlationPath: "data.id",
    });
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

  it("reports both as undefined when the paths miss the payload", () => {
    const routing = buildWebhookRoutingConfig({
      triggerType: "Webhook",
      webhookEventPath: "payload.type",
      webhookCorrelationPath: "payload.data.id",
    });

    expect(deriveWebhookEventContext({ somethingElse: true }, routing)).toEqual(
      {
        eventType: undefined,
        correlationKey: undefined,
      }
    );
  });
});
