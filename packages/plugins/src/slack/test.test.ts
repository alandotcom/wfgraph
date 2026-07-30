/**
 * The Test connection button, for Slack.
 *
 * Slack answers every call with 200 and says no inside the body, so the two
 * refusal branches this covers are the ones that distinction produces: Slack's
 * own slug, and a bare status from whatever stood in front of it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { testSlack } from "#src/slack/test";

const realFetch = globalThis.fetch;

function stubFetch(respond: () => Response): void {
  globalThis.fetch = (() => Promise.resolve(respond())) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("testSlack", () => {
  it("names the credential when there is none", async () => {
    expect(await testSlack({})).toEqual({
      success: false,
      error: "SLACK_API_KEY is required",
    });
  });

  it("accepts a token auth.test reads back", async () => {
    stubFetch(() => Response.json({ ok: true, team: "Fountain" }));

    expect(await testSlack({ SLACK_API_KEY: "xoxb-good" })).toEqual({
      success: true,
    });
  });

  // The slug is the whole message, because it is the only part a person can act
  // on: a 200 carrying `ok: false` is Slack refusing rather than a transport
  // problem.
  it("reports Slack's own slug when Slack is what refused", async () => {
    stubFetch(() => Response.json({ ok: false, error: "invalid_auth" }));

    expect(await testSlack({ SLACK_API_KEY: "xoxb-bad" })).toEqual({
      success: false,
      error: "invalid_auth",
      details: {
        kind: "rejected",
        status: 200,
        slackError: "invalid_auth",
        message: "invalid_auth",
      },
    });
  });

  // Something in front of Slack answering HTML has no slug to read, and the
  // wording says so rather than inventing one.
  it("reports a bare status when the refusal is not Slack's", async () => {
    stubFetch(() => new Response("<html>gateway</html>", { status: 502 }));

    expect(await testSlack({ SLACK_API_KEY: "xoxb-x" })).toEqual({
      success: false,
      error: "API validation failed: HTTP 502",
      details: { kind: "http", status: 502, message: "HTTP 502" },
    });
  });

  it("reports a request that never arrived", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });

    expect(await testSlack({ SLACK_API_KEY: "xoxb-x" })).toEqual({
      success: false,
      error: "ECONNREFUSED",
      details: { kind: "unreachable", message: "ECONNREFUSED" },
    });
  });
});
