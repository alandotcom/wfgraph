/**
 * The Test connection button, for Linear.
 *
 * The seam is `createLinearClient`, stubbed so a case says what `viewer` did.
 * What `toLinearError` makes of a thrown value is `errors.test.ts`'s subject;
 * what is left here is the verdict each of those becomes. Spying the factory
 * (rather than `vi.mock` of `@linear/sdk`) keeps isolate:false from colliding
 * with the other Linear suites that need different client shapes.
 */

import { GraphQLClientError, type LinearRawResponse } from "@linear/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as linearClient from "#src/linear/client";
import { testLinear } from "#src/linear/test";

const mocks = vi.hoisted(() => ({ viewer: vi.fn() }));

beforeEach(() => {
  mocks.viewer.mockReset();
  vi.spyOn(linearClient, "createLinearClient").mockReturnValue({
    get viewer() {
      return mocks.viewer();
    },
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("testLinear", () => {
  it("names the credential when there is none", async () => {
    expect(await testLinear({})).toEqual({
      success: false,
      error: "LINEAR_API_KEY is required",
    });
    expect(mocks.viewer).not.toHaveBeenCalled();
  });

  it("accepts a key whose viewer comes back", async () => {
    mocks.viewer.mockResolvedValue({ id: "user_1" });

    expect(await testLinear({ LINEAR_API_KEY: "lin_api_good" })).toEqual({
      success: true,
    });
  });

  // A viewer with no id is Linear answering without saying who the key belongs
  // to, which is not a connection worth reporting as working.
  it("refuses a viewer that names nobody", async () => {
    mocks.viewer.mockResolvedValue({});

    expect(await testLinear({ LINEAR_API_KEY: "lin_api_x" })).toEqual({
      success: false,
      error: "Failed to verify Linear connection",
    });
  });

  // The authentication type is the one refusal that names something a person can
  // act on, so it gets the credentials sentence rather than Linear's wording.
  it("names the API key when Linear refuses the authentication", async () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const response = {
      status: 401,
      headers: new Headers(),
      errors: [
        {
          message: "Authentication required",
          extensions: { type: "authentication error" },
        },
      ],
    } as unknown as LinearRawResponse<unknown>;

    mocks.viewer.mockRejectedValue(
      new GraphQLClientError(response, { query: "query Me { viewer { id } }" })
    );

    expect(await testLinear({ LINEAR_API_KEY: "lin_api_bad" })).toMatchObject({
      success: false,
      error: "Invalid API key. Please check your Linear API key.",
    });
  });

  // Anything else keeps Linear's own sentence, since a generic one would say
  // less than the message the API sent.
  it("passes any other failure through in Linear's own words", async () => {
    mocks.viewer.mockRejectedValue(new Error("ECONNREFUSED"));

    expect(await testLinear({ LINEAR_API_KEY: "lin_api_x" })).toMatchObject({
      success: false,
      error: "ECONNREFUSED",
    });
  });
});
