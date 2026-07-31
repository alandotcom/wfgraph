/**
 * The Test connection button, for Resend.
 *
 * Every branch here is one the credentials UI shows a person, and the seam is
 * `fetch`: `callExternalAsync` provides the transport itself, so a case says what
 * Resend answered and reads the verdict back.
 */

import { describe, expect, it } from "vitest";
import { afterEach } from "vitest";
import { testResend } from "#src/resend/test";

const realFetch = globalThis.fetch;

function stubFetch(respond: () => Response): void {
  globalThis.fetch = (() => Promise.resolve(respond())) as typeof fetch;
}

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

    for (const key of ["", "sk_live_1", "RE_1"]) {
      expect(await testResend({ RESEND_API_KEY: key })).toEqual({
        success: false,
        error: "Invalid API key format. Resend API keys start with 're_'",
      });
    }
  });

  it("accepts a key that can list domains", async () => {
    stubFetch(() => Response.json({ data: [] }));

    expect(await testResend({ RESEND_API_KEY: "re_good" })).toEqual({
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

    expect(await testResend({ RESEND_API_KEY: "re_restricted" })).toEqual({
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

    expect(await testResend({ RESEND_API_KEY: "re_bad" })).toEqual({
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

    expect(await testResend({ RESEND_API_KEY: "re_x" })).toMatchObject({
      success: false,
      error: "Invalid API key. Please check your Resend API key.",
      details: { statusCode: 403 },
    });
  });

  it("reports any other refusal by its status", async () => {
    stubFetch(() => new Response("<html>gateway</html>", { status: 502 }));

    expect(await testResend({ RESEND_API_KEY: "re_x" })).toEqual({
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

    expect(await testResend({ RESEND_API_KEY: "re_x" })).toEqual({
      success: false,
      error: "ECONNREFUSED",
      details: { message: "ECONNREFUSED" },
    });
  });
});
