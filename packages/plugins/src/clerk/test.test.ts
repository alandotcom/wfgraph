/**
 * The Test connection button, for Clerk.
 *
 * The seam is `fetch`: `callExternalAsync` provides the transport itself, so a
 * case says what Clerk answered and reads the verdict back.
 */

import { describe, expect, it } from "vitest";
import { clerkResponses } from "#src/clerk/responses.fixtures";
import { testClerk } from "#src/clerk/test";
import { recordFetch } from "#src/fetch-test-support";

const wire = recordFetch(() => Response.json([]));

describe("testClerk", () => {
  it("names the credential when there is none", async () => {
    expect(await testClerk({})).toEqual({
      success: false,
      error: "Secret key is required",
    });
    expect(wire.requests).toHaveLength(0);
  });

  // The prefix check costs no request and names the problem more precisely than
  // the 401 the request would come back with. A publishable key pasted into the
  // secret field is the case it catches.
  it("refuses a key that is not a Clerk secret key", async () => {
    for (const key of ["pk_test_1", "sk_1", "SK_TEST_1"]) {
      expect(await testClerk({ CLERK_SECRET_KEY: key })).toEqual({
        success: false,
        error:
          "Invalid secret key format. Clerk secret keys start with 'sk_live_' or 'sk_test_'",
      });
    }
    expect(wire.requests).toHaveLength(0);
  });

  // Listing one user is the cheapest call a secret key can make.
  it("accepts either environment's secret key", async () => {
    expect(await testClerk({ CLERK_SECRET_KEY: "sk_test_1" })).toEqual({
      success: true,
    });
    expect(await testClerk({ CLERK_SECRET_KEY: "sk_live_1" })).toEqual({
      success: true,
    });
    expect(wire.requests.map((request) => request.url)).toEqual([
      "https://api.clerk.com/v1/users?limit=1",
      "https://api.clerk.com/v1/users?limit=1",
    ]);
    expect(wire.requests[1]?.headers.get("authorization")).toBe(
      "Bearer sk_live_1"
    );
  });

  // Clerk's refusal carries a list, and its first entry is the sentence worth
  // showing; the status and the list ride along in the details.
  it("reports Clerk's own first error", async () => {
    wire.answer(() =>
      Response.json(clerkResponses.secretKeyInvalid, { status: 401 })
    );

    expect(await testClerk({ CLERK_SECRET_KEY: "sk_test_bad" })).toEqual({
      success: false,
      error:
        "The provided Clerk Secret Key is invalid. Make sure that your Clerk Secret Key is correct.",
      details: { status: 401, errors: clerkResponses.secretKeyInvalid.errors },
    });
  });

  // Something standing in front of the API answers without Clerk's error body,
  // so the status is all there is to report.
  it("reports the status of a refusal that is not Clerk's", async () => {
    wire.answer(() => new Response("<html>forbidden</html>", { status: 403 }));

    expect(await testClerk({ CLERK_SECRET_KEY: "sk_test_1" })).toEqual({
      success: false,
      error: "403",
      details: { status: 403 },
    });
  });

  // A transport failure carries no status and no list, so the thrown message is
  // the whole story.
  it("reports a request that never arrived", async () => {
    wire.answer(() => {
      throw new Error("ECONNREFUSED");
    });

    expect(await testClerk({ CLERK_SECRET_KEY: "sk_test_1" })).toEqual({
      success: false,
      error: "ECONNREFUSED",
      details: { message: "ECONNREFUSED" },
    });
  });
});
