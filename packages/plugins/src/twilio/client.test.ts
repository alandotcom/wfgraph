import { VendorTransport } from "@rova/core/plugin";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, beforeEach } from "vitest";
import {
  createTwilioMessage,
  describeTwilioFailure,
  fetchTwilioAccount,
  readTwilioError,
} from "#src/twilio/client";

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

/** A call that succeeds fails the flip, which is what makes the test say so. */
const failure = Effect.flip;

const withTransport = Effect.provide(VendorTransport);

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("createTwilioMessage", () => {
  it.effect(
    "form-encodes the parameters and authenticates with basic auth",
    () =>
      Effect.gen(function* () {
        stubFetch(() => Response.json(sentMessage));

        const message = yield* createTwilioMessage(credentials, {
          To: "+15550001111",
          Body: "Hello",
          From: "+15551234567",
        });

        expect(message).toEqual(sentMessage);

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

        const body = new URLSearchParams(yield* readBody());
        expect(Object.fromEntries(body)).toEqual({
          To: "+15550001111",
          Body: "Hello",
          From: "+15551234567",
        });
      }).pipe(withTransport)
  );

  it.effect("leaves out the parameters the caller did not set", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json(sentMessage));

      yield* createTwilioMessage(credentials, {
        To: "+15550001111",
        Body: "Hello",
        From: undefined,
        MessagingServiceSid: "MG1",
      });

      const body = new URLSearchParams(yield* readBody());
      expect(body.has("From")).toBe(false);
      expect(body.get("MessagingServiceSid")).toBe("MG1");
    }).pipe(withTransport)
  );

  // The form encoding carries a list by repeating the key.
  it.effect("repeats MediaUrl once per URL", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json(sentMessage));

      yield* createTwilioMessage(credentials, {
        To: "+15550001111",
        Body: "Hi",
        MediaUrl: ["https://example.com/a.png", "https://example.com/b.png"],
      });

      const body = new URLSearchParams(yield* readBody());
      expect(body.getAll("MediaUrl")).toEqual([
        "https://example.com/a.png",
        "https://example.com/b.png",
      ]);
    }).pipe(withTransport)
  );

  it.effect("reads Twilio's error body back", () =>
    Effect.gen(function* () {
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

      const error = yield* failure(
        createTwilioMessage(credentials, { To: "nope", Body: "Hi" })
      );

      expect(error._tag).toBe("VendorRejected");
      expect(describeTwilioFailure(error)).toBe("Invalid parameter: To");

      const body =
        error._tag === "VendorRejected"
          ? readTwilioError(error.payload)
          : undefined;
      expect(body).toEqual({
        code: 21_211,
        message: "Invalid parameter: To",
        more_info: "https://www.twilio.com/docs/errors/21211",
      });
    }).pipe(withTransport)
  );

  it.effect(
    "falls back to the HTTP status when the body is not Twilio's shape",
    () =>
      Effect.gen(function* () {
        stubFetch(() => new Response("<html>gateway</html>", { status: 502 }));

        const error = yield* failure(
          createTwilioMessage(credentials, { To: "+1555", Body: "Hi" })
        );

        expect(error._tag).toBe("VendorRejected");
        expect(describeTwilioFailure(error)).toBe("HTTP 502");
      }).pipe(withTransport)
  );

  // Reporting success on a body we could not read would hand the run an empty
  // message SID and call it sent.
  it.effect("refuses a 2xx that is not a Message resource", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json({ unexpected: true }));

      const error = yield* failure(
        createTwilioMessage(credentials, { To: "+1555", Body: "Hi" })
      );

      expect(error._tag).toBe("VendorUnreadable");
      expect(describeTwilioFailure(error)).toBe(
        "Twilio answered 200 with an unrecognized body"
      );
    }).pipe(withTransport)
  );
});

describe("fetchTwilioAccount", () => {
  it.effect("reads the account back without a body", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json({ sid: "AC123", status: "active" }));

      yield* fetchTwilioAccount(credentials);

      const request = requests[0];
      expect(request?.url).toBe(
        "https://api.twilio.com/2010-04-01/Accounts/AC123.json"
      );
      expect(request?.method).toBe("GET");
      expect(request?.headers.get("content-type")).toBeNull();
    }).pipe(withTransport)
  );

  // On the live clock, because reading the account is a GET and a GET that
  // never arrives is retried: under the test clock the backoff between attempts
  // would never elapse. What that schedule does is vendor-http.test.ts's
  // subject; here it is just time the call takes.
  it.live("reports an unreachable Twilio with no status at all", () =>
    Effect.gen(function* () {
      stubFetch(() => Promise.reject(new Error("socket hang up")));

      const error = yield* failure(fetchTwilioAccount(credentials));

      expect(error._tag).toBe("VendorUnreachable");
      expect(describeTwilioFailure(error)).toBe("socket hang up");
    }).pipe(withTransport)
  );
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
