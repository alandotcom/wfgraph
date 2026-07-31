import { ExternalTransport } from "@rova/core/plugin";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { afterEach, beforeEach } from "vitest";
import {
  callSlack,
  describeSlackFailure,
  readSlackError,
} from "#src/slack/client";

/**
 * What goes on the wire, now that this plugin builds the request itself instead
 * of handing arguments to @slack/web-api. These assertions are the record of
 * what Slack's Web API reference says the call looks like.
 */

const realFetch = globalThis.fetch;
const postMessageSchema = Schema.Struct({
  ts: Schema.String,
  channel: Schema.String,
});
let requests: Request[] = [];

function stubFetch(
  respond: (request: Request) => Response | Promise<Response>
): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(respond(request));
  }) as typeof fetch;
}

/** A call that succeeds fails the flip, which is what makes the test say so. */
const failure = Effect.flip;

const withTransport = Effect.provide(ExternalTransport);

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("callSlack", () => {
  it.effect("posts JSON to the named method with a bearer token", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json({ ok: true, ts: "1739.1", channel: "C1" }));

      const posted = yield* callSlack(
        "xoxb-token",
        "chat.postMessage",
        postMessageSchema,
        { body: { channel: "#alerts", text: "hi" } }
      );

      expect(posted).toEqual({ ts: "1739.1", channel: "C1" });

      const request = requests[0];
      expect(request?.url).toBe("https://slack.com/api/chat.postMessage");
      expect(request?.method).toBe("POST");
      expect(request?.headers.get("authorization")).toBe("Bearer xoxb-token");
      expect(request?.headers.get("content-type")).toBe(
        "application/json; charset=utf-8"
      );
      expect(yield* readBody()).toBe(
        JSON.stringify({ channel: "#alerts", text: "hi" })
      );
    }).pipe(withTransport)
  );

  it.effect("sends an empty object for a call that takes no arguments", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json({ ok: true }));

      yield* callSlack("xoxb-token", "auth.test", Schema.Struct({}));

      expect(yield* readBody()).toBe("{}");
    }).pipe(withTransport)
  );

  // Slack answers 200 with ok:false for a rejected call, which is the case a
  // status-code check alone would read as success.
  it.effect("reports a rejected call that arrived as HTTP 200", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json({ ok: false, error: "invalid_auth" }));

      const error = yield* failure(
        callSlack("xoxb-bad", "auth.test", Schema.Struct({}))
      );

      expect(error._tag).toBe("ExternalRejected");
      expect(error._tag === "ExternalRejected" ? error.status : undefined).toBe(
        200
      );
      expect(describeSlackFailure(error)).toBe("invalid_auth");
    }).pipe(withTransport)
  );

  it.effect("names the status when something other than Slack answered", () =>
    Effect.gen(function* () {
      stubFetch(() => new Response("nope", { status: 503 }));

      const error = yield* failure(
        callSlack("xoxb-token", "auth.test", Schema.Struct({}))
      );

      expect(error._tag).toBe("ExternalRejected");
      expect(error._tag === "ExternalRejected" ? error.status : undefined).toBe(
        503
      );
      expect(describeSlackFailure(error)).toBe("HTTP 503");
    }).pipe(withTransport)
  );

  it.effect(
    "refuses an ok:true body that is not the shape the caller asked for",
    () =>
      Effect.gen(function* () {
        stubFetch(() => Response.json({ ok: true }));

        const error = yield* failure(
          callSlack("xoxb-token", "chat.postMessage", postMessageSchema)
        );

        expect(error._tag).toBe("ExternalUnreadable");
        expect(
          error._tag === "ExternalUnreadable" ? error.status : undefined
        ).toBe(200);
        expect(describeSlackFailure(error)).toBe("HTTP 200");
      }).pipe(withTransport)
  );

  it.effect("reports an unreachable Slack rather than throwing", () =>
    Effect.gen(function* () {
      stubFetch(() => Promise.reject(new Error("getaddrinfo ENOTFOUND")));

      const error = yield* failure(
        callSlack("xoxb-token", "auth.test", Schema.Struct({}))
      );

      expect(error._tag).toBe("ExternalUnreachable");
      expect(describeSlackFailure(error)).toBe("getaddrinfo ENOTFOUND");
    }).pipe(withTransport)
  );
});

// The connection test words a Slack refusal and a refusal from something in
// front of Slack differently, and this reading is what it decides on.
describe("readSlackError", () => {
  it("names Slack's own slug and nothing else", () => {
    expect(readSlackError({ ok: false, error: "channel_not_found" })).toBe(
      "channel_not_found"
    );
    expect(readSlackError({ ok: false })).toBe("unknown_error");
    expect(readSlackError({ ok: true })).toBeUndefined();
    expect(readSlackError(undefined)).toBeUndefined();
  });
});

/** The body of the request that was sent, as text. */
function readBody(): Effect.Effect<string> {
  return Effect.promise(() => {
    const request = requests[0];
    if (!request) {
      throw new Error("no request was sent");
    }
    return request.text();
  });
}
