import { describe, expect, it } from "vitest";
import {
  actionsByCategory,
  credentialsFromConfig,
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
      id: "Log Event",
      label: "Log Event",
      description: "Write an entry to the run log",
      category: "System",
      configFields: [],
      outputFields: [
        { path: "status", description: "Log write status", type: "number" },
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
});

/**
 * The groups the action selector draws, which is the one lookup that reshapes the
 * catalog rather than searching it.
 *
 * Catalog order is kept inside each group, because that order is assembly's: the
 * built-ins first, then each integration's actions, then a host's own. The editor
 * sorts what it is given, so the lists it gets are copies.
 */
describe("actionsByCategory", () => {
  it("groups every action under its own category, in catalog order", () => {
    expect(actionsByCategory(catalog)).toEqual({
      System: [
        findAction(catalog, "Log Event"),
        findAction(catalog, "Condition"),
      ],
      Twilio: [findAction(catalog, "twilio/send-sms")],
    });
  });

  it("answers with no groups for a catalog holding no actions", () => {
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

/**
 * The mapping from a stored config to the environment-variable names a handler
 * reads it by. Every mapping an integration has is in its credential fields, so
 * this is the whole of it.
 */
describe("credentialsFromConfig", () => {
  const twilio = {
    type: "twilio",
    label: "Twilio",
    description: "Send SMS messages",
    hasTest: true,
    credentialFields: [
      {
        label: "Auth Token",
        type: "password" as const,
        configKey: "authToken",
        envVar: "TWILIO_AUTH_TOKEN",
      },
      {
        label: "From Number",
        type: "text" as const,
        configKey: "fromNumber",
        envVar: "TWILIO_FROM_NUMBER",
      },
      // A field an operator fills in that no handler reads as a variable: the
      // integration stores it and nothing maps it.
      { label: "Label", type: "text" as const, configKey: "label" },
    ],
  };

  it("maps each configured key to the variable its field names", () => {
    expect(
      credentialsFromConfig(twilio, {
        authToken: "secret",
        fromNumber: "+15551234567",
      })
    ).toEqual({
      TWILIO_AUTH_TOKEN: "secret",
      TWILIO_FROM_NUMBER: "+15551234567",
    });
  });

  // A blank value is left out rather than mapped to an empty string, so a handler
  // asking whether a credential is configured reads an absent key.
  it("leaves out a field with no value and one with no variable", () => {
    expect(
      credentialsFromConfig(twilio, {
        authToken: "secret",
        fromNumber: "",
        label: "Main line",
      })
    ).toEqual({ TWILIO_AUTH_TOKEN: "secret" });
  });

  // Which is what a stored row naming an integration the host stopped passing to
  // `createRovaApp` gets: no credentials, rather than a wrong guess at them.
  it("answers nothing for an integration the catalog does not hold", () => {
    expect(credentialsFromConfig(undefined, { authToken: "secret" })).toEqual(
      {}
    );
  });
});
