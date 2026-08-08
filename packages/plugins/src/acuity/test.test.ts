/**
 * The Test connection button, for Acuity.
 *
 * The seam is `acuitySdk.build`, stubbed so a case says what `types` did. Spying
 * that method (rather than `vi.mock` of `@fountain-bio/acuity`) keeps
 * isolate:false from colliding with `appointments.test.ts`.
 */

import { AcuityError } from "@fountain-bio/acuity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acuitySdk } from "#src/acuity/client";
import { testAcuity } from "#src/acuity/test";

const mocks = vi.hoisted(() => ({ types: vi.fn() }));

const credentials = {
  ACUITY_USER_ID: "12345678",
  ACUITY_API_KEY: "acuity-key",
};

beforeEach(() => {
  mocks.types.mockReset();
  vi.spyOn(acuitySdk, "build").mockReturnValue({
    appointments: { types: mocks.types },
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("testAcuity", () => {
  // Both halves are needed to build the client, so either missing is the same
  // answer and the SDK is never constructed.
  it("names both credentials when either is missing or blank", async () => {
    const expected = {
      success: false,
      error: "ACUITY_USER_ID and ACUITY_API_KEY are required",
    };

    expect(await testAcuity({})).toEqual(expected);
    expect(await testAcuity({ ACUITY_USER_ID: "1" })).toEqual(expected);
    // Whitespace is what a paste out of a spreadsheet leaves behind.
    expect(
      await testAcuity({ ACUITY_USER_ID: "  ", ACUITY_API_KEY: "k" })
    ).toEqual(expected);
    expect(mocks.types).not.toHaveBeenCalled();
  });

  it("accepts credentials that can list appointment types", async () => {
    mocks.types.mockResolvedValue([]);

    expect(await testAcuity(credentials)).toEqual({ success: true });
  });

  // Acuity says "Unauthorized" in words rather than by a code the SDK exposes,
  // so the word is what the credentials sentence is chosen on.
  it("names the credentials when Acuity says unauthorized", async () => {
    mocks.types.mockRejectedValue(
      new AcuityError({
        status: 401,
        code: "unauthorized",
        message: "Unauthorized",
      })
    );

    expect(await testAcuity(credentials)).toMatchObject({
      success: false,
      error:
        "Invalid Acuity credentials. Please check your User ID and API key.",
      details: { status: 401, code: "unauthorized" },
    });
  });

  // Any other refusal keeps Acuity's own sentence: it says more than a generic
  // one would, and the status rides along in the details.
  it("passes any other refusal through in Acuity's own words", async () => {
    mocks.types.mockRejectedValue(
      new AcuityError({ status: 429, message: "Rate limit exceeded" })
    );

    expect(await testAcuity(credentials)).toMatchObject({
      success: false,
      error: "Rate limit exceeded",
      details: { status: 429, message: "Rate limit exceeded" },
    });
  });

  // A transport error is not an `AcuityError`, so it carries no status to
  // report and only its message is left.
  it("reports a request that never arrived", async () => {
    mocks.types.mockRejectedValue(new Error("ECONNREFUSED"));

    expect(await testAcuity(credentials)).toEqual({
      success: false,
      error: "ECONNREFUSED",
      details: { message: "ECONNREFUSED" },
    });
  });
});
