import { describe, expect, it, vi } from "vitest";
import type { Inngest } from "inngest";
import { CONNECTION_STAMP_KEY } from "#src/backend/lib/inngest/catalog-connection";
import {
  sendCatalogEvent,
  sendWorkflowWaitSignal,
} from "#src/backend/lib/inngest/runtime-events";
import { workflowWaitSignal } from "#src/backend/lib/inngest/events";

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
      id: "resend/webhook-conn_1-msg_1",
    });
  });

  it("gives two Connections different ids for one vendor message", async () => {
    // Resend sends one svix-id to every endpoint subscribed to the account, so
    // passing it through raw would let Inngest drop the second send as a
    // duplicate and leave that Connection's workflows unstarted.
    const { send, client } = clientSpy();

    for (const connectionId of ["conn_1", "conn_2"]) {
      // eslint-disable-next-line no-await-in-loop -- two sends, read in order.
      await sendCatalogEvent(client, {
        name: "resend/webhook",
        data: envelope,
        connectionId,
        id: "msg_1",
      });
    }

    const ids = send.mock.calls.map(([event]) => event.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("keeps one Connection's retry deduplicated", async () => {
    const { send, client } = clientSpy();
    const input = {
      name: "resend/webhook",
      data: envelope,
      connectionId: "conn_1",
      id: "msg_1",
    };

    await sendCatalogEvent(client, input);
    await sendCatalogEvent(client, input);

    const [first, second] = send.mock.calls.map(([event]) => event.id);
    expect(first).toBe(second);
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

describe("sendWorkflowWaitSignal", () => {
  // Every reason a parked run is woken. A schema that admitted fewer would
  // refuse the send rather than the wait, so this is checked where it is built.
  it.each([
    "wait-resume",
    "lifecycle-cancel",
    "lifecycle-exit",
    "version-migrate",
  ] as const)("accepts a %s signal", async (signalType) => {
    const { send, client } = clientSpy();

    await sendWorkflowWaitSignal(client, {
      executionId: "exec_1",
      nodeId: "wait_1",
      signalType,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]?.[0] as { data: { signalType: string } };
    expect(sent.data.signalType).toBe(signalType);
  });

  // Inngest validates the payload through this schema on send, which is where a
  // reason no wait admits is stopped.
  it("refuses a reason the wait expressions do not admit", async () => {
    const validated = await workflowWaitSignal.schema["~standard"].validate({
      executionId: "exec_1",
      nodeId: "wait_1",
      signalType: "made-up",
    });

    expect(validated.issues).toBeDefined();
  });
});
