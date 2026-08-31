import { describe, expect, it, vi } from "vitest";
import type { Inngest } from "inngest";
import { CONNECTION_STAMP_KEY } from "#src/backend/lib/inngest/catalog-connection";
import { sendCatalogEvent } from "#src/backend/lib/inngest/runtime-events";

/** As much of an Inngest send as these cases read. */
type SentEvent = { name: string; data: unknown; id?: string };

function clientSpy() {
  const send = vi.fn(async (_event: SentEvent) => ({ ids: ["evt_1"] }));
  return { send, client: { send } as unknown as Inngest };
}

const envelope = { type: "email.delivered", created_at: "2026-01-01" };

describe("sendCatalogEvent", () => {
  it("stamps the Connection on data rather than user", async () => {
    const { send, client } = clientSpy();

    await sendCatalogEvent(client, {
      name: "resend/webhook",
      data: envelope,
      connectionId: "conn_1",
      id: "msg_1",
    });

    expect(send).toHaveBeenCalledWith({
      name: "resend/webhook",
      data: { ...envelope, [CONNECTION_STAMP_KEY]: "conn_1" },
      id: "msg_1",
    });
  });

  it("sends no id when the vendor gave none", async () => {
    const { send, client } = clientSpy();

    await sendCatalogEvent(client, {
      name: "resend/webhook",
      data: envelope,
      connectionId: "conn_1",
    });

    expect(send).toHaveBeenCalledWith({
      name: "resend/webhook",
      data: { ...envelope, [CONNECTION_STAMP_KEY]: "conn_1" },
    });
  });
});
