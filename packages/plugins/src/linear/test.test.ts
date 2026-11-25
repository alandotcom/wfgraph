/**
 * The Test connection button, for Linear.
 *
 * The seam is `fetch`: `callExternalAsync` provides the transport itself, so a
 * case says what Linear answered to the viewer query and reads the verdict back.
 */

import { afterEach, describe, expect, it } from "vitest";
import { testLinear } from "#src/linear/test";

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

describe("testLinear", () => {
  it("names the credential when there is none", async () => {
    stubFetch(() => Response.json({}));

    expect(await testLinear({})).toEqual({
      success: false,
      error: "LINEAR_API_KEY is required",
    });
    expect(requests).toHaveLength(0);
  });

  it("accepts a key whose viewer comes back", async () => {
    stubFetch(() => Response.json({ data: { viewer: { id: "user_1" } } }));

    expect(await testLinear({ LINEAR_API_KEY: "lin_api_good" })).toEqual({
      success: true,
    });
    expect(requests[0]?.headers.get("authorization")).toBe("lin_api_good");
  });

  // A viewer with no id is Linear answering without saying who the key belongs
  // to, which is not a connection worth reporting as working.
  it("refuses a viewer that names nobody", async () => {
    stubFetch(() => Response.json({ data: { viewer: {} } }));

    expect(await testLinear({ LINEAR_API_KEY: "lin_api_x" })).toMatchObject({
      success: false,
      error: "Failed to verify Linear connection",
    });
  });

  // The authentication type is the one refusal that names something a person can
  // act on, so it gets the credentials sentence rather than Linear's wording.
  it("names the API key when Linear refuses the authentication", async () => {
    stubFetch(() =>
      Response.json(
        {
          errors: [
            {
              message: "Authentication required, not authenticated",
              extensions: {
                type: "authentication error",
                code: "AUTHENTICATION_ERROR",
                statusCode: 401,
                userError: true,
                userPresentableMessage:
                  "You need to authenticate to access this operation.",
              },
            },
          ],
        },
        { status: 400 }
      )
    );

    expect(await testLinear({ LINEAR_API_KEY: "lin_api_bad" })).toEqual({
      success: false,
      error: "Invalid API key. Please check your Linear API key.",
      details: {
        status: 400,
        code: "AUTHENTICATION_ERROR",
        message: "You need to authenticate to access this operation.",
      },
    });
  });

  // Anything else keeps Linear's own sentence, because a generic one would say
  // less than the message the API sent.
  it("passes any other refusal through in Linear's own words", async () => {
    stubFetch(() =>
      Response.json({
        data: null,
        errors: [
          {
            message: "Forbidden",
            extensions: { type: "forbidden", code: "FORBIDDEN" },
          },
        ],
      })
    );

    expect(await testLinear({ LINEAR_API_KEY: "lin_api_x" })).toMatchObject({
      success: false,
      error: "Forbidden",
    });
  });

  // A request that never arrived has no HTTP status to report, so the result
  // carries the transport's message alone. The viewer query is a read, so it
  // is retried, and the case waits out that schedule on the real clock.
  it("reports a request that never arrived", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });

    expect(await testLinear({ LINEAR_API_KEY: "lin_api_x" })).toEqual({
      success: false,
      error: "ECONNREFUSED",
      details: { message: "ECONNREFUSED" },
    });
  });
});
