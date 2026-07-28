import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTwilioMessage, fetchTwilioAccount } from "#src/twilio/client";

/**
 * What goes on the wire, now that this plugin builds the request itself instead
 * of handing arguments to the `twilio` SDK. These assertions are the record of
 * what Twilio's 2010-04-01 Message resource reference says the call looks like.
 */

const realFetch = globalThis.fetch;
const credentials = { accountSid: "AC123", authToken: "auth-token" };
const sentMessage = {
  sid: "SM1",
  status: "queued",
  to: "+15550001111",
  from: "+15551234567",
  messaging_service_sid: null,
};
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

describe("createTwilioMessage", () => {
  it("form-encodes the parameters and authenticates with basic auth", async () => {
    stubFetch(() => Response.json(sentMessage));

    const result = await createTwilioMessage(credentials, {
      To: "+15550001111",
      Body: "Hello",
      From: "+15551234567",
    });

    expect(result).toEqual({ ok: true, data: sentMessage });

    const request = requests[0];
    expect(request?.url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json"
    );
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("AC123:auth-token").toString("base64")}`
    );
    expect(request?.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded"
    );

    const body = new URLSearchParams(await (request as Request).text());
    expect(Object.fromEntries(body)).toEqual({
      To: "+15550001111",
      Body: "Hello",
      From: "+15551234567",
    });
  });

  it("leaves out the parameters the caller did not set", async () => {
    stubFetch(() => Response.json(sentMessage));

    await createTwilioMessage(credentials, {
      To: "+15550001111",
      Body: "Hello",
      From: undefined,
      MessagingServiceSid: "MG1",
    });

    const body = new URLSearchParams(await (requests[0] as Request).text());
    expect(body.has("From")).toBe(false);
    expect(body.get("MessagingServiceSid")).toBe("MG1");
  });

  // The form encoding carries a list by repeating the key.
  it("repeats MediaUrl once per URL", async () => {
    stubFetch(() => Response.json(sentMessage));

    await createTwilioMessage(credentials, {
      To: "+15550001111",
      Body: "Hi",
      MediaUrl: ["https://example.com/a.png", "https://example.com/b.png"],
    });

    const body = new URLSearchParams(await (requests[0] as Request).text());
    expect(body.getAll("MediaUrl")).toEqual([
      "https://example.com/a.png",
      "https://example.com/b.png",
    ]);
  });

  it("reads Twilio's error body back", async () => {
    stubFetch(() =>
      Response.json(
        {
          code: 21_211,
          message: "Invalid parameter: To",
          more_info: "https://www.twilio.com/docs/errors/21211",
          status: 400,
        },
        { status: 400 }
      )
    );

    expect(
      await createTwilioMessage(credentials, { To: "nope", Body: "Hi" })
    ).toEqual({
      ok: false,
      failure: {
        kind: "rejected",
        status: 400,
        code: 21_211,
        message: "Invalid parameter: To",
        moreInfo: "https://www.twilio.com/docs/errors/21211",
      },
    });
  });

  it("falls back to the HTTP status when the body is not Twilio's shape", async () => {
    stubFetch(() => new Response("<html>gateway</html>", { status: 502 }));

    expect(
      await createTwilioMessage(credentials, { To: "+1555", Body: "Hi" })
    ).toEqual({
      ok: false,
      failure: {
        kind: "rejected",
        status: 502,
        message: "HTTP 502",
        code: undefined,
        moreInfo: undefined,
      },
    });
  });

  // Reporting success on a body we could not read would hand the run an empty
  // message SID and call it sent.
  it("refuses a 2xx that is not a Message resource", async () => {
    stubFetch(() => Response.json({ unexpected: true }));

    expect(
      await createTwilioMessage(credentials, { To: "+1555", Body: "Hi" })
    ).toEqual({
      ok: false,
      failure: { kind: "unreadable", status: 200 },
    });
  });
});

describe("fetchTwilioAccount", () => {
  it("reads the account back without a body", async () => {
    stubFetch(() => Response.json({ sid: "AC123", status: "active" }));

    await fetchTwilioAccount(credentials);

    const request = requests[0];
    expect(request?.url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/AC123.json"
    );
    expect(request?.method).toBe("GET");
    expect(request?.headers.get("content-type")).toBeNull();
  });

  it("reports an unreachable Twilio with no status at all", async () => {
    stubFetch(() => Promise.reject(new Error("socket hang up")));

    expect(await fetchTwilioAccount(credentials)).toEqual({
      ok: false,
      failure: { kind: "unreachable", message: "socket hang up" },
    });
  });
});
