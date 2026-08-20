/**
 * The Test connection button, for PostHog.
 *
 * The branches worth covering are the ones the flags endpoint produces that
 * capture could not: a project key PostHog refuses, and a host that answers
 * something else entirely.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { testPostHog } from "#src/posthog/test";

const realFetch = globalThis.fetch;

function stubFetch(respond: () => Response): void {
  globalThis.fetch = (() => Promise.resolve(respond())) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("testPostHog", () => {
  it("names the credential when there is none", async () => {
    expect(await testPostHog({})).toEqual({
      success: false,
      error: "POSTHOG_PROJECT_API_KEY is required",
    });
  });

  // A personal API key pasted into this box is the common mistake, and the
  // prefix names it before a request is spent earning a 401 that would not.
  it("names the prefix before spending a request", async () => {
    const spent = vi.fn();
    globalThis.fetch = spent as unknown as typeof fetch;

    expect(
      await testPostHog({ POSTHOG_PROJECT_API_KEY: "phx_personal" })
    ).toEqual({
      success: false,
      error:
        "Invalid project API key format. PostHog project API keys start with 'phc_'",
    });
    expect(spent).not.toHaveBeenCalled();
  });

  it("accepts a key the flags endpoint evaluates", async () => {
    stubFetch(() =>
      Response.json({ featureFlags: {}, errorsWhileComputingFlags: false })
    );

    expect(await testPostHog({ POSTHOG_PROJECT_API_KEY: "phc_good" })).toEqual({
      success: true,
    });
  });

  it("reports PostHog's own detail when PostHog is what refused", async () => {
    stubFetch(() =>
      Response.json(
        {
          type: "authentication_error",
          code: "authentication_failed",
          detail:
            "The provided API key is invalid or has expired. Please check your API key and try again.",
          attr: null,
        },
        { status: 401 }
      )
    );

    expect(await testPostHog({ POSTHOG_PROJECT_API_KEY: "phc_bad" })).toEqual({
      success: false,
      error: "API validation failed: HTTP 401",
      details: {
        kind: "rejected",
        status: 401,
        code: "authentication_failed",
        message:
          "The provided API key is invalid or has expired. Please check your API key and try again.",
      },
    });
  });

  // A host that is not PostHog has no `detail` to read, and the wording says so
  // rather than inventing one.
  it("reports a bare status when the refusal is not PostHog's", async () => {
    stubFetch(() => new Response("<html>gateway</html>", { status: 502 }));

    expect(await testPostHog({ POSTHOG_PROJECT_API_KEY: "phc_x" })).toEqual({
      success: false,
      error: "API validation failed: HTTP 502",
      details: {
        kind: "rejected",
        status: 502,
        code: undefined,
        message: "HTTP 502",
      },
    });
  });

  // A mistyped host lands here rather than on a status, which is the difference
  // between "PostHog said no" and "nothing answered".
  it("reports a request that never arrived", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });

    expect(await testPostHog({ POSTHOG_PROJECT_API_KEY: "phc_x" })).toEqual({
      success: false,
      error: "ECONNREFUSED",
      details: { kind: "unreachable", message: "ECONNREFUSED" },
    });
  });
});
