import { describe, expect, it } from "vitest";
import {
  actionsByCategory,
  emptyExtensionCatalog,
  type ExtensionCatalog,
  findAction,
  findEvent,
  findIntegration,
} from "./catalog";
import { readExtensionCatalog } from "./catalog-wire";

const catalog: ExtensionCatalog = {
  events: [
    {
      name: "app/appointment.created",
      label: "Appointment created",
      description: "Raised when a new appointment is booked.",
      correlationPath: "appointment.id",
      payloadFields: [
        {
          path: "appointment.id",
          description: "Appointment ID",
          type: "string",
        },
      ],
    },
    {
      name: "billing/payment.settled",
      label: "Payment settled",
      payloadFields: [],
    },
  ],
  actions: [
    {
      id: "HTTP Request",
      label: "HTTP Request",
      description: "Make an HTTP request to any API",
      category: "System",
      configFields: [],
      outputFields: [
        { path: "status", description: "HTTP status code", type: "number" },
      ],
    },
    {
      id: "twilio/send-sms",
      label: "Send SMS",
      description: "Send an SMS via Twilio",
      category: "Twilio",
      integration: "twilio",
      configFields: [
        { key: "smsTo", label: "To", type: "template-input", required: true },
      ],
      outputFields: [
        { path: "sid", description: "Message SID", type: "string" },
      ],
    },
    {
      id: "Condition",
      label: "Condition",
      description: "Branch based on a condition",
      category: "System",
      configFields: [],
      outputFields: [],
    },
  ],
  integrations: [
    {
      type: "twilio",
      label: "Twilio",
      description: "Send SMS messages with Twilio",
      credentialFields: [
        {
          id: "accountSid",
          label: "Account SID",
          type: "text",
          configKey: "accountSid",
          envVar: "TWILIO_ACCOUNT_SID",
        },
      ],
      hasTest: true,
    },
  ],
};

/** What the browser actually decodes: the document after it crossed the wire. */
function overTheWire(document: ExtensionCatalog): unknown {
  return JSON.parse(JSON.stringify(document));
}

describe("catalog lookups", () => {
  it("finds an Event by name", () => {
    expect(findEvent(catalog, "billing/payment.settled")?.label).toBe(
      "Payment settled"
    );
  });

  it("finds an action by id and an integration by type", () => {
    expect(findAction(catalog, "twilio/send-sms")?.label).toBe("Send SMS");
    expect(findIntegration(catalog, "twilio")?.label).toBe("Twilio");
  });

  it("answers undefined for a name the catalog has never heard of", () => {
    expect(findEvent(catalog, "app/nothing.happened")).toBeUndefined();
    expect(findAction(catalog, "twilio/send-mms")).toBeUndefined();
    expect(findIntegration(catalog, "postmark")).toBeUndefined();
  });

  it("groups actions by category, keeping catalog order within a group", () => {
    const grouped = actionsByCategory(catalog);

    expect(Object.keys(grouped).toSorted()).toEqual(["System", "Twilio"]);
    expect(grouped.System.map((action) => action.id)).toEqual([
      "HTTP Request",
      "Condition",
    ]);
  });

  it("groups nothing from the empty catalog", () => {
    expect(actionsByCategory(emptyExtensionCatalog)).toEqual({});
  });
});

describe("the catalog wire schema", () => {
  it("decodes a served catalog back to what the server assembled", () => {
    expect(readExtensionCatalog(overTheWire(catalog))).toEqual(catalog);
  });

  it("leaves an absent optional key absent rather than holding undefined", () => {
    const decoded = readExtensionCatalog(overTheWire(catalog));

    expect(decoded?.events[1]).not.toHaveProperty("description");
    expect(decoded?.events[1]).not.toHaveProperty("correlationPath");
  });

  it("decodes the empty catalog", () => {
    expect(readExtensionCatalog(overTheWire(emptyExtensionCatalog))).toEqual(
      emptyExtensionCatalog
    );
  });

  // A config field type the editor cannot draw is not a usable field, and the
  // document is built from typed values, so one arriving means the two halves of
  // a deployment disagree about the contract.
  it("refuses a config field the renderer has no case for", () => {
    const document = overTheWire({
      ...catalog,
      actions: [
        {
          id: "twilio/send-sms",
          label: "Send SMS",
          description: "Send an SMS via Twilio",
          category: "Twilio",
          configFields: [
            // eslint-disable-next-line typescript/no-unsafe-type-assertion -- a shape the server cannot build, which is the point
            { key: "smsTo", label: "To", type: "hologram" } as never,
          ],
          outputFields: [],
        },
      ],
    });

    expect(readExtensionCatalog(document)).toBeUndefined();
  });

  it("refuses an action carrying no id", () => {
    const document = overTheWire({
      ...catalog,
      actions: [
        {
          id: "  ",
          label: "Nameless",
          description: "",
          category: "System",
          configFields: [],
          outputFields: [],
        },
      ],
    });

    expect(readExtensionCatalog(document)).toBeUndefined();
  });

  it("refuses a document missing a list", () => {
    expect(readExtensionCatalog({ events: [], actions: [] })).toBeUndefined();
  });
});
