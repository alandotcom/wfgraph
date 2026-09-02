import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slack } from "#src/slack/index";

const realFetch = globalThis.fetch;
const oauthClient = { clientId: "client-id", clientSecret: "client-secret" };
const redirectUri = "https://workflow.example.com/oauth/slack";
const accessToken = "xoxb-access-token";
const refreshToken = "xoxe-refresh-token";
let requests: Request[] = [];

function configuredOAuth() {
  const oauth = slack({ oauthClient }).oauth;
  if (!oauth) {
    throw new Error("Slack OAuth was not configured");
  }
  if (oauth.pkce !== undefined) {
    throw new Error("Slack OAuth must not request PKCE");
  }
  return oauth;
}

function stubFetch(
  respond: (request: Request) => Response | Promise<Response>
): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(respond(request));
  }) as typeof fetch;
}

async function readBody(request: Request): Promise<URLSearchParams> {
  return new URLSearchParams(await request.text());
}

beforeEach(() => {
  requests = [];
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

describe("Slack OAuth definition", () => {
  it("keeps the manual integration unchanged when no client is supplied", () => {
    expect(slack().oauth).toBeUndefined();
    expect(Object.keys(slack().credentials)).toEqual(["SLACK_API_KEY"]);
    expect(Object.keys(slack().actions)).toEqual(["send-message"]);
  });

  it.each([
    { clientId: undefined, clientSecret: "secret" },
    { clientId: "client", clientSecret: undefined },
    { clientId: " ", clientSecret: "secret" },
    { clientId: "client", clientSecret: "\t" },
  ])(
    "rejects an incomplete OAuth client: $clientId / $clientSecret",
    (client) => {
      expect(() => slack({ oauthClient: client })).toThrow(
        /Slack OAuth requires non-empty oauthClient\.clientId and oauthClient\.clientSecret/
      );
    }
  );

  // A host passes its environment straight through, so both blank means the
  // variables are unset and Slack is manual-only.
  it.each([
    { clientId: undefined, clientSecret: undefined },
    { clientId: "", clientSecret: " " },
  ])("stays manual-only for a blank OAuth client", (client) => {
    expect(slack({ oauthClient: client }).oauth).toBeUndefined();
  });

  it("registers a confidential client without putting secrets in the definition", () => {
    const oauth = configuredOAuth();
    const registration = oauth.registerClient({
      publicUrl: "https://workflow.example.com",
      callbackUrl: redirectUri,
      metadataDocumentUrl: "https://workflow.example.com/.well-known/oauth",
    });

    expect(registration).toEqual(oauthClient);
    expect(registration).not.toHaveProperty("metadataDocument");
    const definitionJson = JSON.stringify(slack({ oauthClient }));
    expect(definitionJson).not.toContain(oauthClient.clientId);
    expect(definitionJson).not.toContain(oauthClient.clientSecret);
  });

  it("builds Slack's authorization URL without PKCE", () => {
    const url = configuredOAuth().authorize({
      client: oauthClient,
      redirectUri,
      state: "state-value",
    });

    expect(url.toString()).toBe(
      "https://slack.com/oauth/v2/authorize?client_id=client-id&scope=chat%3Awrite&redirect_uri=https%3A%2F%2Fworkflow.example.com%2Foauth%2Fslack&state=state-value"
    );
  });

  it("exchanges a code with Basic auth and the exact redirect URI", async () => {
    stubFetch(() =>
      Response.json({
        ok: true,
        access_token: accessToken,
        team: { id: "T123", name: "Acme" },
      })
    );

    const grant = await configuredOAuth().exchange({
      client: oauthClient,
      code: "authorization-code",
      redirectUri,
    });

    expect(grant).toEqual({
      credentials: { SLACK_API_KEY: accessToken },
      tokens: { accessToken },
      accountLabel: "Acme",
    });
    const request = requests[0];
    expect(request?.url).toBe("https://slack.com/api/oauth.v2.access");
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`
    );
    expect(request?.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded"
    );
    expect(Object.fromEntries(await readBody(request!))).toEqual({
      code: "authorization-code",
      redirect_uri: redirectUri,
    });
  });

  it("normalizes Slack's rotating token response", async () => {
    stubFetch(() =>
      Response.json({
        ok: true,
        access_token: accessToken,
        expires_in: 43200,
        refresh_token: refreshToken,
        team: { id: "T123" },
      })
    );

    await expect(
      configuredOAuth().exchange({
        client: oauthClient,
        code: "authorization-code",
        redirectUri,
      })
    ).resolves.toEqual({
      credentials: { SLACK_API_KEY: accessToken },
      tokens: {
        accessToken,
        refreshToken,
        expiresAt: "2026-01-01T12:00:00.000Z",
      },
    });
  });

  it("refreshes with confidential Basic auth and requires replacement tokens", async () => {
    stubFetch(() =>
      Response.json({
        ok: true,
        access_token: "xoxb-new-access",
        expires_in: 3600,
        refresh_token: "xoxe-new-refresh",
      })
    );

    const grant = await configuredOAuth().refresh({
      client: oauthClient,
      grant: {
        credentials: { SLACK_API_KEY: accessToken },
        tokens: { accessToken, refreshToken },
      },
    });

    expect(grant).toEqual({
      credentials: { SLACK_API_KEY: "xoxb-new-access" },
      tokens: {
        accessToken: "xoxb-new-access",
        refreshToken: "xoxe-new-refresh",
        expiresAt: "2026-01-01T01:00:00.000Z",
      },
    });
    const request = requests[0];
    expect(request?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`
    );
    expect(Object.fromEntries(await readBody(request!))).toEqual({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
  });

  it("rejects a refresh response that omits the replacement refresh token", async () => {
    stubFetch(() =>
      Response.json({
        ok: true,
        access_token: "xoxb-new-access",
        expires_in: 3600,
      })
    );

    await expect(
      configuredOAuth().refresh({
        client: oauthClient,
        grant: {
          credentials: { SLACK_API_KEY: accessToken },
          tokens: { accessToken, refreshToken },
        },
      })
    ).rejects.toThrow("replacement refresh_token");
  });

  it("uninstalls through apps.uninstall with all required form fields", async () => {
    stubFetch(() => Response.json({ ok: true }));

    await configuredOAuth().revoke({
      client: oauthClient,
      grant: {
        credentials: { SLACK_API_KEY: accessToken },
        tokens: { accessToken },
      },
    });

    const request = requests[0];
    expect(request?.url).toBe("https://slack.com/api/apps.uninstall");
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("authorization")).toBeNull();
    expect(Object.fromEntries(await readBody(request!))).toEqual({
      token: accessToken,
      client_id: oauthClient.clientId,
      client_secret: oauthClient.clientSecret,
    });
  });

  it("sanitizes malformed Slack errors and makes one request", async () => {
    const leakedValue = "authorization-code-and-access-token";
    stubFetch(() =>
      Response.json(
        {
          ok: false,
          error: `invalid_code:${leakedValue}`,
          access_token: leakedValue,
        },
        { status: 503 }
      )
    );

    const error = await configuredOAuth()
      .exchange({ client: oauthClient, code: leakedValue, redirectUri })
      .catch((cause: unknown) =>
        cause instanceof Error ? cause.message : String(cause)
      );

    expect(error).toContain("invalid_code");
    expect(error).not.toContain(leakedValue);
    expect(requests).toHaveLength(1);
  });
});
