/**
 * The Test connection button, for Clerk.
 *
 * The seam is `createClerkBackendClient` in `#src/clerk/client`, stubbed here
 * so a case says what the SDK did and reads the verdict back. Spying that
 * export (rather than `vi.mock` of `@clerk/backend`) keeps isolate:false from
 * colliding with `clerk-users.test.ts`, which owns the same client module.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as clerkClient from "#src/clerk/client";
import { testClerk } from "#src/clerk/test";

const mocks = vi.hoisted(() => ({ getUserList: vi.fn() }));

beforeEach(() => {
  mocks.getUserList.mockReset();
  vi.spyOn(clerkClient, "createClerkBackendClient").mockReturnValue({
    users: { getUserList: mocks.getUserList },
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("testClerk", () => {
  it("names the credential when there is none", async () => {
    expect(await testClerk({})).toEqual({
      success: false,
      error: "Secret key is required",
    });
    expect(mocks.getUserList).not.toHaveBeenCalled();
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
    expect(mocks.getUserList).not.toHaveBeenCalled();
  });

  it("accepts either environment's secret key", async () => {
    mocks.getUserList.mockResolvedValue({ data: [] });

    expect(await testClerk({ CLERK_SECRET_KEY: "sk_test_1" })).toEqual({
      success: true,
    });
    expect(await testClerk({ CLERK_SECRET_KEY: "sk_live_1" })).toEqual({
      success: true,
    });
  });

  // Clerk's refusal carries a list, and its first entry is the sentence worth
  // showing; the status and the list ride along in the details.
  it("reports Clerk's own first error over the wrapper's message", async () => {
    mocks.getUserList.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), {
        status: 401,
        errors: [{ message: "The API key is invalid" }],
      })
    );

    expect(await testClerk({ CLERK_SECRET_KEY: "sk_test_bad" })).toEqual({
      success: false,
      error: "The API key is invalid",
      details: {
        status: 401,
        errors: [{ message: "The API key is invalid" }],
        message: "Unauthorized",
      },
    });
  });

  // A transport failure carries no status and no list, so the thrown message is
  // the whole story.
  it("reports a request that never arrived", async () => {
    mocks.getUserList.mockRejectedValue(new Error("ECONNREFUSED"));

    expect(await testClerk({ CLERK_SECRET_KEY: "sk_test_1" })).toEqual({
      success: false,
      error: "ECONNREFUSED",
      details: { message: "ECONNREFUSED" },
    });
  });
});
