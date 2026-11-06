import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiApp, machineRoutes } from "#src/backend/api-app";
import { defineEvent } from "#src/backend/extensions/define-event";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";
import {
  defineWfGraphAuth,
  resolveAuth,
  WfGraphAccess,
} from "#src/backend/lib/http/authorize";
import { MAX_REQUEST_BODY_BYTES } from "#src/backend/lib/http/capped-body";
import {
  DriverError,
  type ExecutionDriver,
} from "#src/backend/services/executions/driver";
import { sendEvent } from "#src/backend/services/executions/send-event";

const EVENTS_KEY = "events-key-0123456789";

/** A value the tests send that no refusal may repeat back to the sender. */
const SECRET = "4111-1111-1111-1111";

const extensions = assembleExtensions({
  events: [
    defineEvent({
      name: "app/appointment.created",
      schema: Schema.Struct({ appointmentId: Schema.String }),
      correlationPath: "appointmentId",
    }),
  ],
});

type ReceiveEvent = ExecutionDriver["Service"]["receiveEvent"];

function runtimeFor(receive?: ReceiveEvent) {
  const receiveEvent = vi.fn<ReceiveEvent>(
    receive ??
      (() =>
        Effect.succeed({
          duplicate: false,
          inboxId: "inbox_1",
          scheduleId: "schedule_1",
        }))
  );
  return {
    receiveEvent,
    runtime: stubWfGraphRuntime({
      extensions,
      executionDriver: { receiveEvent },
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendEvent", () => {
  it("records a catalog Event in the inbox under its id", async () => {
    const { runtime, receiveEvent } = runtimeFor();
    await using _ = runtime;

    const sent = await runtime.runPromise(
      sendEvent({
        name: "app/appointment.created",
        data: { appointmentId: "appt_1", extra: true },
        id: "booking_1",
      })
    );

    expect(sent).toEqual({ id: "inbox_1", duplicate: false });
    // The gate ignores keys the schema never declared, and the row keeps the
    // data as it was sent.
    expect(receiveEvent).toHaveBeenCalledWith({
      name: "app/appointment.created",
      data: { appointmentId: "appt_1", extra: true },
      connectionId: null,
      idempotencyKey: "booking_1",
    });
  });

  it("answers a repeated id with the inbox row that holds it", async () => {
    const { runtime, receiveEvent } = runtimeFor(() =>
      Effect.succeed({ duplicate: true, inboxId: "inbox_first" })
    );
    await using _ = runtime;

    const sent = await runtime.runPromise(
      sendEvent({
        name: "app/appointment.created",
        data: { appointmentId: "appt_1" },
        id: "booking_1",
      })
    );

    expect(sent).toEqual({ id: "inbox_first", duplicate: true });
    expect(receiveEvent).toHaveBeenCalledTimes(1);
  });

  it("records a send with no id under no idempotency key", async () => {
    const { runtime, receiveEvent } = runtimeFor();
    await using _ = runtime;

    await runtime.runPromise(
      sendEvent({
        name: "app/appointment.created",
        data: { appointmentId: "appt_1" },
      })
    );

    expect(receiveEvent.mock.lastCall?.[0].idempotencyKey).toBeNull();
  });

  it("refuses a name no catalog Event has, without repeating it", async () => {
    const { runtime, receiveEvent } = runtimeFor();
    await using _ = runtime;

    const failure = await runtime.runPromise(
      sendEvent({ name: SECRET, data: {} }).pipe(Effect.flip)
    );

    expect(failure._tag).toBe("InvalidInput");
    expect(failure.error).toBe("name: No catalog Event has this name");
    expect(receiveEvent).not.toHaveBeenCalled();
  });

  it("refuses data the Event's schema refuses, without repeating it", async () => {
    const { runtime, receiveEvent } = runtimeFor();
    await using _ = runtime;

    const failure = await runtime.runPromise(
      sendEvent({
        name: "app/appointment.created",
        data: { appointmentId: { card: SECRET } },
      }).pipe(Effect.flip)
    );

    expect(failure._tag).toBe("InvalidInput");
    expect(failure.error).toMatch(
      /^Payload refused for Event "app\/appointment.created": /
    );
    expect(failure.error).toContain("appointmentId");
    expect(failure.error).not.toContain(SECRET);
    expect(receiveEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["data that is not an object", { name: "app/x", data: [SECRET] }],
    ["a blank id", { name: "app/x", data: {}, id: "  " }],
    ["a key it does not know", { name: "app/x", data: {}, extra: SECRET }],
    ["no name", { data: {} }],
  ])("refuses a send with %s", async (_label, input) => {
    const { runtime, receiveEvent } = runtimeFor();
    await using _ = runtime;

    const failure = await runtime.runPromise(
      sendEvent(input).pipe(Effect.flip)
    );

    expect(failure._tag).toBe("InvalidInput");
    expect(failure.error).not.toContain(SECRET);
    expect(receiveEvent).not.toHaveBeenCalled();
  });

  it("answers a refused inbox write as internal", async () => {
    const { runtime } = runtimeFor(() =>
      Effect.fail(new DriverError({ cause: new Error("disk full") }))
    );
    await using _ = runtime;

    const failure = await runtime.runPromise(
      sendEvent({
        name: "app/appointment.created",
        data: { appointmentId: "appt_1" },
      }).pipe(Effect.flip)
    );

    expect(failure._tag).toBe("InternalFailure");
    expect(failure.error).toBe("Could not send this Event");
  });
});

describe("events HTTP route", () => {
  function appFor(
    input: { eventsKey?: string | undefined; hostAllows?: boolean } = {}
  ) {
    const fixture = runtimeFor();
    const app = createApiApp({
      basePath: "/api",
      // Host auth refuses everyone unless a case says otherwise, so only the
      // route's own key can let a sender through.
      auth: resolveAuth(
        defineWfGraphAuth(() => (input.hostAllows ? WfGraphAccess.all : null))
      ),
      runtime: fixture.runtime,
      eventsKey: input.eventsKey,
    });
    return { ...fixture, app };
  }

  function post(
    app: ReturnType<typeof appFor>["app"],
    input: { authorization?: string | undefined; body: string }
  ) {
    const headers = new Headers({ "content-type": "application/json" });
    if (input.authorization !== undefined) {
      headers.set("authorization", input.authorization);
    }
    return app.fetch(
      new Request("http://localhost/api/events", {
        method: "POST",
        headers,
        body: input.body,
      })
    );
  }

  const created = JSON.stringify({
    name: "app/appointment.created",
    data: { appointmentId: "appt_1" },
    id: "booking_1",
  });

  it("is a machine route only when a key is set", () => {
    expect(
      machineRoutes({ serveInngest: false, acceptEvents: true })
    ).toContain("/events");
    expect(
      machineRoutes({ serveInngest: false, acceptEvents: false })
    ).not.toContain("/events");
  });

  it("answers 202 with the inbox row for the right key", async () => {
    const { app, runtime, receiveEvent } = appFor({ eventsKey: EVENTS_KEY });
    await using _ = runtime;

    const response = await post(app, {
      authorization: `Bearer ${EVENTS_KEY}`,
      body: created,
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ id: "inbox_1", duplicate: false });
    expect(receiveEvent).toHaveBeenCalledWith({
      name: "app/appointment.created",
      data: { appointmentId: "appt_1" },
      connectionId: null,
      idempotencyKey: "booking_1",
    });
  });

  it.each([
    ["no Authorization header", undefined],
    [
      "a wrong key of the same length",
      `Bearer ${"x".repeat(EVENTS_KEY.length)}`,
    ],
    [
      "a key that is a prefix of the right one",
      `Bearer ${EVENTS_KEY.slice(0, 5)}`,
    ],
    ["the right key under another scheme", `Basic ${EVENTS_KEY}`],
  ])("answers 401 for %s", async (_label, authorization) => {
    const { app, runtime, receiveEvent } = appFor({ eventsKey: EVENTS_KEY });
    await using _ = runtime;

    const response = await post(app, { authorization, body: created });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(receiveEvent).not.toHaveBeenCalled();
  });

  it("answers 400 for an unknown Event name, without repeating it", async () => {
    const { app, runtime } = appFor({ eventsKey: EVENTS_KEY });
    await using _ = runtime;

    const response = await post(app, {
      authorization: `Bearer ${EVENTS_KEY}`,
      body: JSON.stringify({ name: SECRET, data: {} }),
    });

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      error: "name: No catalog Event has this name",
    });
    expect(body).not.toContain(SECRET);
  });

  it("answers 400 for a refused payload, without repeating it", async () => {
    const { app, runtime } = appFor({ eventsKey: EVENTS_KEY });
    await using _ = runtime;

    const response = await post(app, {
      authorization: `Bearer ${EVENTS_KEY}`,
      body: JSON.stringify({
        name: "app/appointment.created",
        data: { appointmentId: [SECRET] },
      }),
    });

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("Payload refused for Event");
    expect(body).not.toContain(SECRET);
  });

  it("answers 400 for a body that is not JSON", async () => {
    const { app, runtime } = appFor({ eventsKey: EVENTS_KEY });
    await using _ = runtime;

    const response = await post(app, {
      authorization: `Bearer ${EVENTS_KEY}`,
      body: "{",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Request body must be valid JSON",
    });
  });

  it("answers 413 for a body over the ceiling", async () => {
    const { app, runtime, receiveEvent } = appFor({ eventsKey: EVENTS_KEY });
    await using _ = runtime;

    const response = await post(app, {
      authorization: `Bearer ${EVENTS_KEY}`,
      body: "x".repeat(MAX_REQUEST_BODY_BYTES + 1),
    });

    expect(response.status).toBe(413);
    expect(receiveEvent).not.toHaveBeenCalled();
  });

  it("is not mounted without a key", async () => {
    const gated = appFor();
    const open = appFor({ hostAllows: true });
    try {
      // Host auth answers the path like any other operator route, and a
      // request it lets through finds nothing there.
      const refused = await post(gated.app, {
        authorization: `Bearer ${EVENTS_KEY}`,
        body: created,
      });
      const missing = await post(open.app, {
        authorization: `Bearer ${EVENTS_KEY}`,
        body: created,
      });

      expect(refused.status).toBe(401);
      expect(missing.status).toBe(404);
      expect(gated.receiveEvent).not.toHaveBeenCalled();
      expect(open.receiveEvent).not.toHaveBeenCalled();
    } finally {
      await gated.runtime.dispose();
      await open.runtime.dispose();
    }
  });
});
