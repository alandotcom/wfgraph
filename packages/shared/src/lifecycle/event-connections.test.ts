import { describe, expect, it } from "vitest";
import type { ExtensionCatalog } from "#src/extensions/catalog";
import {
  connectionIdFor,
  connectionMatches,
  inheritConnections,
  stampConnection,
} from "./event-connections";

const catalog: ExtensionCatalog = {
  events: [
    {
      name: "app/appointment.created",
      label: "Appointment created",
      payloadFields: [],
    },
    {
      name: "resend/email.sent",
      label: "Email sent",
      integration: "resend",
      payloadFields: [],
    },
    {
      name: "resend/email.delivered",
      label: "Email delivered",
      integration: "resend",
      payloadFields: [],
    },
  ],
  actions: [],
  integrations: [
    {
      type: "resend",
      label: "Resend",
      description: "Send transactional emails",
      credentialFields: {},
      hasTest: false,
      hasWebhook: false,
    },
  ],
};

describe("connectionMatches", () => {
  it("matches every arrival when nothing was stored", () => {
    expect(connectionMatches(undefined, undefined)).toBe(true);
    expect(connectionMatches(undefined, "conn_1")).toBe(true);
  });

  it("matches only the stored Connection", () => {
    expect(connectionMatches("conn_1", "conn_1")).toBe(true);
    expect(connectionMatches("conn_1", "conn_other")).toBe(false);
    expect(connectionMatches("conn_1", undefined)).toBe(false);
  });
});

describe("connectionIdFor", () => {
  it("reads the stored Connection for an integration from any of its Events", () => {
    expect(
      connectionIdFor(
        [
          { event: "resend/email.sent" },
          { event: "resend/email.delivered", connectionId: "conn_1" },
          { event: "app/appointment.created" },
        ],
        catalog,
        "resend"
      )
    ).toBe("conn_1");
  });
});

describe("stampConnection", () => {
  it("stamps one Connection onto every Event of that integration", () => {
    expect(
      stampConnection({
        bindings: [
          { event: "resend/email.sent" },
          { event: "resend/email.delivered" },
          { event: "app/appointment.created" },
        ],
        catalog,
        integration: "resend",
        connectionId: "conn_1",
      })
    ).toEqual([
      { event: "resend/email.sent", connectionId: "conn_1" },
      { event: "resend/email.delivered", connectionId: "conn_1" },
      { event: "app/appointment.created" },
    ]);
  });

  it("clears a blank id and keeps other fields", () => {
    expect(
      stampConnection({
        bindings: [
          {
            event: "resend/email.sent",
            connectionId: "conn_1",
            match: "kept",
          },
        ],
        catalog,
        integration: "resend",
        connectionId: "",
      })
    ).toEqual([{ event: "resend/email.sent", match: "kept" }]);
  });
});

describe("inheritConnections", () => {
  it("copies a sibling Connection onto a newly named Event of the same integration", () => {
    expect(
      inheritConnections(
        [
          { event: "resend/email.sent", connectionId: "conn_1" },
          { event: "resend/email.delivered" },
        ],
        catalog
      )
    ).toEqual([
      { event: "resend/email.sent", connectionId: "conn_1" },
      { event: "resend/email.delivered", connectionId: "conn_1" },
    ]);
  });
});
