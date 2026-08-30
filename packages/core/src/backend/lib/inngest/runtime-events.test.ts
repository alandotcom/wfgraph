import { describe, expect, it, vi } from "vitest";
import type { Inngest } from "inngest";
import {
  sendCatalogEvent,
  splitCatalogEventData,
  withCatalogConnection,
} from "#src/backend/lib/inngest/runtime-events";

describe("catalog Event data", () => {
  it("stamps connectionId on data rather than user", async () => {
    const send = vi.fn(async () => ({ ids: ["evt_1"] }));
    const client = { send } as unknown as Inngest;

    await sendCatalogEvent(client, {
      name: "resend/webhook",
      data: { type: "email.delivered", created_at: "2026-01-01" },
      connectionId: "conn_1",
      id: "msg_1",
    });

    expect(send).toHaveBeenCalledWith({
      name: "resend/webhook",
      data: {
        type: "email.delivered",
        created_at: "2026-01-01",
        connectionId: "conn_1",
      },
      id: "msg_1",
    });
  });

  it("splits the stamp off and leaves the vendor envelope", () => {
    const stamped = withCatalogConnection(
      {
        type: "email.delivered",
        created_at: "2026-01-01",
        data: { email_id: "e1" },
      },
      "conn_1"
    );

    expect(splitCatalogEventData(stamped, { connectionStamped: true })).toEqual(
      {
        payload: {
          type: "email.delivered",
          created_at: "2026-01-01",
          data: { email_id: "e1" },
        },
        connectionId: "conn_1",
      }
    );
  });

  it("leaves a host Event's data alone", () => {
    const payload = { appointment: { id: "appt_1" } };
    expect(
      splitCatalogEventData(payload, { connectionStamped: false })
    ).toEqual({
      payload,
      connectionId: undefined,
    });
  });

  it("does not treat a host Event's connectionId field as delivery metadata", () => {
    const payload = { appointment: { id: "appt_1" }, connectionId: "not-ours" };
    expect(
      splitCatalogEventData(payload, { connectionStamped: false })
    ).toEqual({
      payload,
      connectionId: undefined,
    });
  });
});
