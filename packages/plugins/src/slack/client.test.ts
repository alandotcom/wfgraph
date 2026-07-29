import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { callSlack, describeSlackFailure } from "#src/slack/client";

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

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("callSlack", () => {
  it("posts JSON to the named method with a bearer token", async () => {
    stubFetch(() => Response.json({ ok: true, ts: "1739.1", channel: "C1" }));

    const result = await callSlack(
      "xoxb-token",
      "chat.postMessage",
      postMessageSchema,
      { body: { channel: "#alerts", text: "hi" } }
    );

    expect(result).toEqual({ ok: true, data: { ts: "1739.1", channel: "C1" } });

    const request = requests[0];
    expect(request?.url).toBe("https://slack.com/api/chat.postMessage");
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("authorization")).toBe("Bearer xoxb-token");
    expect(request?.headers.get("content-type")).toBe(
      "application/json; charset=utf-8"
    );
    expect(await request?.text()).toBe(
      JSON.stringify({ channel: "#alerts", text: "hi" })
    );
  });

  it("sends an empty object for a call that takes no arguments", async () => {
    stubFetch(() => Response.json({ ok: true }));

    await callSlack("xoxb-token", "auth.test", Schema.Struct({}));

    expect(await requests[0]?.text()).toBe("{}");
  });

  // Slack answers 200 with ok:false for a rejected call, which is the case a
  // status-code check alone would read as success.
  it("reports a rejected call that arrived as HTTP 200", async () => {
    stubFetch(() => Response.json({ ok: false, error: "invalid_auth" }));

    expect(await callSlack("xoxb-bad", "auth.test", Schema.Struct({}))).toEqual(
      {
        ok: false,
        failure: { kind: "rejected", status: 200, slackError: "invalid_auth" },
      }
    );
  });

  it("names the status when something other than Slack answered", async () => {
    stubFetch(() => new Response("nope", { status: 503 }));

    expect(
      await callSlack("xoxb-token", "auth.test", Schema.Struct({}))
    ).toEqual({
      ok: false,
      failure: { kind: "http", status: 503 },
    });
  });

  it("refuses an ok:true body that is not the shape the caller asked for", async () => {
    stubFetch(() => Response.json({ ok: true }));

    expect(
      await callSlack("xoxb-token", "chat.postMessage", postMessageSchema)
    ).toEqual({ ok: false, failure: { kind: "http", status: 200 } });
  });

  it("reports an unreachable Slack rather than throwing", async () => {
    stubFetch(() => Promise.reject(new Error("getaddrinfo ENOTFOUND")));

    expect(
      await callSlack("xoxb-token", "auth.test", Schema.Struct({}))
    ).toEqual({
      ok: false,
      failure: { kind: "unreachable", message: "getaddrinfo ENOTFOUND" },
    });
  });
});

describe("describeSlackFailure", () => {
  it("says what a user can act on for each kind of failure", () => {
    expect(
      describeSlackFailure({ kind: "unreachable", message: "ENOTFOUND" })
    ).toBe("ENOTFOUND");
    expect(
      describeSlackFailure({
        kind: "rejected",
        status: 200,
        slackError: "channel_not_found",
      })
    ).toBe("channel_not_found");
    expect(describeSlackFailure({ kind: "http", status: 429 })).toBe(
      "HTTP 429"
    );
  });
});
