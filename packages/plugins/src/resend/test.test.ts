/**
 * The Test connection button, for Resend.
 *
 * Every branch here is one the credentials UI shows a person, and the seam is
 * `fetch`: `callExternalAsync` provides the transport itself, so a case says what
 * Resend answered and reads the verdict back.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testResend } from "#src/resend/test";

/** A key the operator typed into the form themselves. */
const manual = { oauthCredentialKeys: [] };
/** A key the stored Resend OAuth grant issued. */
const granted = { oauthCredentialKeys: ["RESEND_API_KEY"] };

const realFetch = globalThis.fetch;
let requests: Request[] = [];

function stubFetch(respond: (request: Request) => Response): void {
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

describe("testResend", () => {
  // The prefix check costs no request and names the problem more precisely than
  // the 401 the request would come back with.
  it("refuses a key that is not shaped like a Resend key", async () => {
    stubFetch(() => {
      throw new Error("no request should be made");
    });

    for (const key of ["", "sk_live_1", "RE_1", "header.payload"]) {
      expect(await testResend({ RESEND_API_KEY: key }, manual)).toEqual({
        success: false,
        error: "Invalid API key format. Resend API keys start with 're_'",
      });
    }
  });

  // A grant issues an opaque token that has no "re_" to check, so the prefix
  // rule is asked of a manual key alone and the request goes out as normal.
  it("skips the prefix rule for a granted token and validates it normally", async () => {
    stubFetch(() => Response.json({ data: [] }));

    expect(
      await testResend({ RESEND_API_KEY: "granted-token" }, granted)
    ).toEqual({ success: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.resend.com/domains");
  });

  // Resend's grant asks for `emails:send` rather than `full_access`, so the
  // domains route refuses a working token by name.
  it("accepts a granted token the domains route refuses for its scopes", async () => {
    stubFetch(() =>
      Response.json(
        {
          statusCode: 403,
          name: "invalid_permission",
          message: "Access token is missing required scopes: full_access",
        },
        { status: 403 }
      )
    );

    expect(
      await testResend({ RESEND_API_KEY: "granted-token" }, granted)
    ).toEqual({ success: true });
  });

  // The same slug over a manual key means the key really is refused: no grant
  // asked for narrower scopes on its behalf.
  it("does not accept invalid_permission for a manual API key", async () => {
    stubFetch(() =>
      Response.json(
        {
          statusCode: 403,
          name: "invalid_permission",
          message: "Permission denied",
        },
        { status: 403 }
      )
    );

    expect(
      await testResend({ RESEND_API_KEY: "re_manual" }, manual)
    ).toMatchObject({
      success: false,
      details: { errorName: "invalid_permission" },
    });
  });

  it("accepts a key that can list domains", async () => {
    stubFetch(() => Response.json({ data: [] }));

    expect(await testResend({ RESEND_API_KEY: "re_good" }, manual)).toEqual({
      success: true,
    });
  });

  // A send-only key cannot list domains and says so by name. That is still a
  // working key, and refusing it would leave a builder unable to connect the
  // one credential the send step needs.
  it("accepts a send-only key by the slug it is refused with", async () => {
    stubFetch(() =>
      Response.json(
        { statusCode: 401, name: "restricted_api_key", message: "no" },
        { status: 401 }
      )
    );

    expect(
      await testResend({ RESEND_API_KEY: "re_restricted" }, manual)
    ).toEqual({
      success: true,
    });
  });

  it("reports a rejected key as one to check", async () => {
    stubFetch(() =>
      Response.json(
        { statusCode: 401, name: "validation_error", message: "bad key" },
        { status: 401 }
      )
    );

    expect(await testResend({ RESEND_API_KEY: "re_bad" }, manual)).toEqual({
      success: false,
      error: "Invalid API key. Please check your Resend API key.",
      details: {
        statusCode: 401,
        errorName: "validation_error",
        errorMessage: "bad key",
      },
    });
  });

  // Resend quotes a status inside its own error body, and that one wins: a
  // proxy in front of it can answer 500 over a body Resend wrote as a 403.
  it("takes the status from the error body over the response", async () => {
    stubFetch(() =>
      Response.json(
        { statusCode: 403, name: "restricted", message: "denied" },
        { status: 500 }
      )
    );

    expect(await testResend({ RESEND_API_KEY: "re_x" }, manual)).toMatchObject({
      success: false,
      error: "Invalid API key. Please check your Resend API key.",
      details: { statusCode: 403 },
    });
  });

  it("reports any other refusal by its status", async () => {
    stubFetch(() => new Response("<html>gateway</html>", { status: 502 }));

    expect(await testResend({ RESEND_API_KEY: "re_x" }, manual)).toEqual({
      success: false,
      error: "API validation failed: HTTP 502",
      details: {
        statusCode: 502,
        errorName: undefined,
        errorMessage: "HTTP 502",
      },
    });
  });

  // A request that never arrived has no status to report, so the transport
  // error is the whole story.
  it("reports a request that never arrived", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });

    expect(await testResend({ RESEND_API_KEY: "re_x" }, manual)).toEqual({
      success: false,
      error: "ECONNREFUSED",
      details: { message: "ECONNREFUSED" },
    });
  });
});
