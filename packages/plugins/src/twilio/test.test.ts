/**
 * The Test connection button, for Twilio.
 *
 * The seam is `fetch`: `runVendorCall` provides the transport itself, so a case
 * says what Twilio answered and reads the verdict back.
 */

import { afterEach, describe, expect, it } from "vitest";
import { testTwilio } from "#src/twilio/test";

const realFetch = globalThis.fetch;
let requests: Request[] = [];

function stubFetch(respond: () => Response): void {
  requests = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return Promise.resolve(respond());
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("testTwilio", () => {
  // Twilio authenticates with a pair, so either half missing is the same answer
  // and no request is worth making.
  it("names both credentials when either is missing", async () => {
    const expected = {
      success: false,
      error: "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required",
    };

    expect(await testTwilio({})).toEqual(expected);
    expect(await testTwilio({ TWILIO_ACCOUNT_SID: "AC1" })).toEqual(expected);
    expect(await testTwilio({ TWILIO_AUTH_TOKEN: "tok" })).toEqual(expected);
  });

  // Reading the account back is the cheapest call the pair can make, and it is
  // the account named in the credentials that is read.
  it("accepts a pair that can read its own account", async () => {
    stubFetch(() => Response.json({ sid: "AC1" }));

    expect(
      await testTwilio({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok" })
    ).toEqual({ success: true });
    expect(requests[0]?.url).toContain("/Accounts/AC1.json");
  });

  it("carries Twilio's own code and help link on a refusal", async () => {
    stubFetch(() =>
      Response.json(
        {
          code: 20_003,
          message: "Authenticate",
          more_info: "https://www.twilio.com/docs/errors/20003",
        },
        { status: 401 }
      )
    );

    expect(
      await testTwilio({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "bad" })
    ).toEqual({
      success: false,
      error: "API validation failed: HTTP 401",
      details: {
        status: 401,
        code: 20_003,
        moreInfo: "https://www.twilio.com/docs/errors/20003",
        message: "Authenticate",
      },
    });
  });

  // A request that never arrived has no status to report, so the transport
  // error is the whole story.
  it("reports a request that never arrived", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });

    expect(
      await testTwilio({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok" })
    ).toEqual({
      success: false,
      error: "ECONNREFUSED",
      details: { message: "ECONNREFUSED" },
    });
  });
});
