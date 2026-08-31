import { describe, expect, it } from "vitest";
import {
  CONNECTION_STAMP_KEY,
  splitCatalogEventData,
  withCatalogConnection,
} from "#src/backend/lib/inngest/catalog-connection";

const envelope = {
  type: "email.delivered",
  created_at: "2026-01-01",
  data: { email_id: "e1" },
};

describe("catalog Event connection stamp", () => {
  it("splits the stamp off and leaves the vendor envelope", () => {
    const stamped = withCatalogConnection(envelope, "conn_1");

    expect(stamped[CONNECTION_STAMP_KEY]).toBe("conn_1");
    expect(splitCatalogEventData(stamped, { connectionStamped: true })).toEqual(
      {
        payload: envelope,
        connectionId: "conn_1",
      }
    );
  });

  it("leaves a vendor's own connectionId field as payload", () => {
    // The vendor owns every key but the reserved one, so a Resend-style
    // envelope carrying `connectionId` reaches conditions and templates whole.
    const vendor = { ...envelope, connectionId: "the vendor's own" };
    const stamped = withCatalogConnection(vendor, "conn_1");

    expect(splitCatalogEventData(stamped, { connectionStamped: true })).toEqual(
      {
        payload: vendor,
        connectionId: "conn_1",
      }
    );
  });

  it("leaves a host Event's data alone", () => {
    const payload = { appointment: { id: "appt_1" } };
    expect(
      splitCatalogEventData(payload, { connectionStamped: false })
    ).toEqual({ payload, connectionId: undefined });
  });

  it("reads no Connection from a stamped Event that carries none", () => {
    expect(
      splitCatalogEventData(envelope, { connectionStamped: true })
    ).toEqual({ payload: envelope, connectionId: undefined });
  });
});
