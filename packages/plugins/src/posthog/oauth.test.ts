import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { posthog } from "#src/posthog/index";

const oauth = posthog.oauth;

if (oauth === undefined) {
  throw new Error("PostHog must always offer OAuth");
}

if (oauth.pkce !== "S256") {
  throw new Error("PostHog OAuth must request S256 PKCE");
}

const clientContext = {
  publicUrl: "https://workflow.example.com",
  callbackUrl: "https://workflow.example.com/api/oauth/posthog/callback",
  metadataDocumentUrl: "https://workflow.example.com/oauth/posthog-client.json",
};

const client = oauth.registerClient(clientContext);

const realFetch = globalThis.fetch;
let requests: Request[] = [];

function stubFetch(
  respond: (request: Request) => Response | Promise<Response>
): void {
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
  vi.restoreAllMocks();
});

function form(request: Request): Promise<URLSearchParams> {
  return request.text().then((body) => new URLSearchParams(body));
}

const tokenResponse = {
  access_token: "pha_access",
  token_type: "Bearer",
  expires_in: 36000,
  refresh_token: "phr_refresh",
  scope: "project:read",
  scoped_teams: [12],
};

const usProject = {
  id: 12,
  name: "Production",
  api_token: "phc_us_token",
};

const euProject = {
  id: 12,
  name: "EU Production",
  api_token: "phc_eu_token",
};

function respondForRegion(options: {
  readonly us?: Response | (() => Response);
  readonly eu?: Response | (() => Response);
}): (request: Request) => Response {
  return (request) => {
    if (request.url === "https://oauth.posthog.com/oauth/token/") {
      return Response.json(tokenResponse);
    }

    if (request.url.startsWith("https://us.posthog.com")) {
      const us = options.us;
      if (!us) {
        throw new Error(`unexpected US request: ${request.url}`);
      }
      return typeof us === "function" ? us() : us;
    }

    if (request.url.startsWith("https://eu.posthog.com")) {
      const eu = options.eu;
      if (!eu) {
        throw new Error(`unexpected EU request: ${request.url}`);
      }
      return typeof eu === "function" ? eu() : eu;
    }

    throw new Error(`unexpected request: ${request.url}`);
  };
}

describe("PostHog OAuth registration", () => {
  it("uses the metadata document URL as the public client id", () => {
    expect(client).toEqual({
      clientId: clientContext.metadataDocumentUrl,
      metadataDocument: {
        client_id: clientContext.metadataDocumentUrl,
        client_name: "Workflow Graph",
        client_uri: clientContext.publicUrl,
        redirect_uris: [clientContext.callbackUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: "project:read",
      },
    });
  });

  it("builds an authorization URL with PKCE, project scope, and a forced project pick", () => {
    const url = oauth.authorize({
      client,
      redirectUri: clientContext.callbackUrl,
      state: "state-value",
      codeChallenge: "challenge-value",
    });

    expect(url.toString()).toBe(
      "https://oauth.posthog.com/oauth/authorize/?client_id=https%3A%2F%2Fworkflow.example.com%2Foauth%2Fposthog-client.json&response_type=code&redirect_uri=https%3A%2F%2Fworkflow.example.com%2Fapi%2Foauth%2Fposthog%2Fcallback&state=state-value&scope=project%3Aread&required_access_level=project&code_challenge=challenge-value&code_challenge_method=S256"
    );
  });
});

describe("PostHog OAuth token exchange", () => {
  it("posts the authorization-code form, reads the US project, and maps capture credentials", async () => {
    stubFetch(
      respondForRegion({
        us: Response.json(usProject),
      })
    );
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    await expect(
      oauth.exchange({
        client,
        code: "authorization-code",
        redirectUri: clientContext.callbackUrl,
        codeVerifier: "code-verifier",
      })
    ).resolves.toEqual({
      accountLabel: "Production",
      credentials: {
        POSTHOG_PROJECT_API_KEY: "phc_us_token",
        POSTHOG_HOST: "https://us.i.posthog.com",
      },
      grantedAccessLabel: "Project access",
      tokens: {
        accessToken: "pha_access",
        expiresAt: "2023-11-15T08:13:20.000Z",
        refreshToken: "phr_refresh",
      },
    });

    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toBe("https://oauth.posthog.com/oauth/token/");
    expect(requests[0]?.headers.get("content-type")).toContain(
      "application/x-www-form-urlencoded"
    );
    await expect(form(requests[0] as Request)).resolves.toEqual(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.clientId,
        code: "authorization-code",
        redirect_uri: clientContext.callbackUrl,
        code_verifier: "code-verifier",
      })
    );

    expect(requests[1]?.method).toBe("GET");
    expect(requests[1]?.url).toBe("https://us.posthog.com/api/projects/12/");
    expect(requests[1]?.headers.get("authorization")).toBe("Bearer pha_access");
    expect(requests).toHaveLength(2);
  });

  it("falls through to EU when the US private API refuses the token", async () => {
    stubFetch(
      respondForRegion({
        us: () => Response.json({ detail: "Invalid" }, { status: 401 }),
        eu: Response.json(euProject),
      })
    );

    await expect(
      oauth.exchange({
        client,
        code: "authorization-code",
        redirectUri: clientContext.callbackUrl,
        codeVerifier: "code-verifier",
      })
    ).resolves.toMatchObject({
      accountLabel: "EU Production",
      credentials: {
        POSTHOG_PROJECT_API_KEY: "phc_eu_token",
        POSTHOG_HOST: "https://eu.i.posthog.com",
      },
    });

    expect(requests.map((request) => request.url)).toEqual([
      "https://oauth.posthog.com/oauth/token/",
      "https://us.posthog.com/api/projects/12/",
      "https://eu.posthog.com/api/projects/12/",
    ]);
  });

  it("lists projects when the token names no team and takes the only result", async () => {
    stubFetch((request) => {
      if (request.url === "https://oauth.posthog.com/oauth/token/") {
        return Response.json({
          ...tokenResponse,
          scoped_teams: [],
        });
      }

      if (request.url === "https://us.posthog.com/api/projects/") {
        return Response.json({ results: [usProject] });
      }

      throw new Error(`unexpected request: ${request.url}`);
    });

    await expect(
      oauth.exchange({
        client,
        code: "authorization-code",
        redirectUri: clientContext.callbackUrl,
        codeVerifier: "code-verifier",
      })
    ).resolves.toMatchObject({
      credentials: {
        POSTHOG_PROJECT_API_KEY: "phc_us_token",
        POSTHOG_HOST: "https://us.i.posthog.com",
      },
    });

    expect(requests[1]?.url).toBe("https://us.posthog.com/api/projects/");
  });

  it("refuses a grant that is not scoped to a single project", async () => {
    stubFetch((request) => {
      if (request.url === "https://oauth.posthog.com/oauth/token/") {
        return Response.json({
          ...tokenResponse,
          scoped_teams: [],
        });
      }

      if (request.url === "https://us.posthog.com/api/projects/") {
        return Response.json({ results: [usProject, euProject] });
      }

      throw new Error(`unexpected request: ${request.url}`);
    });

    await expect(
      oauth.exchange({
        client,
        code: "authorization-code",
        redirectUri: clientContext.callbackUrl,
        codeVerifier: "code-verifier",
      })
    ).rejects.toThrow("PostHog OAuth must be scoped to a single project.");
  });

  it("refuses a project payload that omits the capture API key", async () => {
    stubFetch(
      respondForRegion({
        us: Response.json({ id: 12, name: "Production" }),
      })
    );

    await expect(
      oauth.exchange({
        client,
        code: "authorization-code",
        redirectUri: clientContext.callbackUrl,
        codeVerifier: "code-verifier",
      })
    ).rejects.toThrow(
      "PostHog did not return a project API key for this grant."
    );
  });

  it("does not retry a token exchange POST", async () => {
    stubFetch(() =>
      Response.json({ error: "temporarily_unavailable" }, { status: 503 })
    );

    await expect(
      oauth.exchange({
        client,
        code: "authorization-code",
        redirectUri: clientContext.callbackUrl,
        codeVerifier: "code-verifier",
      })
    ).rejects.toThrow("temporarily_unavailable");
    expect(requests).toHaveLength(1);
  });

  it("refuses an unreadable token response", async () => {
    stubFetch(() => new Response("<html>gateway</html>", { status: 200 }));

    await expect(
      oauth.exchange({
        client,
        code: "authorization-code",
        redirectUri: clientContext.callbackUrl,
        codeVerifier: "code-verifier",
      })
    ).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  it("validates the complete token response shape", async () => {
    stubFetch(() =>
      Response.json({
        ...tokenResponse,
        token_type: "bearer",
        expires_in: 0,
      })
    );

    await expect(
      oauth.exchange({
        client,
        code: "authorization-code",
        redirectUri: clientContext.callbackUrl,
        codeVerifier: "code-verifier",
      })
    ).rejects.toThrow();
  });

  it("keeps authorization values out of provider error messages", async () => {
    const code = "authorization-code-secret";
    const verifier = "code-verifier-secret";
    stubFetch(() =>
      Response.json(
        {
          error: "invalid_grant",
          error_description: `The code ${code} and verifier ${verifier} are invalid`,
        },
        { status: 400 }
      )
    );

    const result = await oauth
      .exchange({
        client,
        code,
        redirectUri: clientContext.callbackUrl,
        codeVerifier: verifier,
      })
      .catch((error: unknown) => String(error));

    expect(result).toContain("invalid_grant");
    expect(result).not.toContain(code);
    expect(result).not.toContain(verifier);
  });
});

describe("PostHog OAuth refresh and revoke", () => {
  const storedCredentials = {
    POSTHOG_PROJECT_API_KEY: "phc_us_token",
    POSTHOG_HOST: "https://us.i.posthog.com",
  };

  it("rotates the refresh token and keeps the stored project credentials", async () => {
    stubFetch(() => Response.json(tokenResponse));
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    await expect(
      oauth.refresh({
        client,
        grant: {
          credentials: storedCredentials,
          tokens: {
            accessToken: "pha_old",
            refreshToken: "phr_old",
          },
        },
      })
    ).resolves.toEqual({
      credentials: storedCredentials,
      grantedAccessLabel: "Project access",
      tokens: {
        accessToken: "pha_access",
        expiresAt: "2023-11-15T08:13:20.000Z",
        refreshToken: "phr_refresh",
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://oauth.posthog.com/oauth/token/");
    await expect(form(requests[0] as Request)).resolves.toEqual(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: "phr_old",
      })
    );
  });

  it("requires the replacement refresh token", async () => {
    stubFetch(() =>
      Response.json({
        ...tokenResponse,
        refresh_token: undefined,
      })
    );

    await expect(
      oauth.refresh({
        client,
        grant: {
          credentials: storedCredentials,
          tokens: { accessToken: "pha_old", refreshToken: "phr_old" },
        },
      })
    ).rejects.toThrow();
  });

  it("revokes the current refresh token with an empty 200 response", async () => {
    stubFetch(() => new Response(null, { status: 200 }));

    await expect(
      oauth.revoke({
        client,
        grant: {
          credentials: storedCredentials,
          tokens: { accessToken: "pha_access", refreshToken: "phr_old" },
        },
      })
    ).resolves.toBeUndefined();

    const request = requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("https://oauth.posthog.com/oauth/revoke/");
    await expect(form(request as Request)).resolves.toEqual(
      new URLSearchParams({
        client_id: client.clientId,
        token: "phr_old",
        token_type_hint: "refresh_token",
      })
    );
  });

  it("does not retry revocation and keeps token values out of errors", async () => {
    const refreshToken = "phr_secret";
    const accessToken = "pha_secret";
    stubFetch(() =>
      Response.json(
        {
          error: "invalid_grant",
          error_description: `The tokens ${refreshToken} and ${accessToken} are invalid`,
        },
        { status: 400 }
      )
    );

    const result = await oauth
      .revoke({
        client,
        grant: {
          credentials: storedCredentials,
          tokens: { accessToken, refreshToken },
        },
      })
      .catch((error: unknown) => String(error));

    expect(result).toContain("invalid_grant");
    expect(result).not.toContain(refreshToken);
    expect(result).not.toContain(accessToken);
    expect(requests).toHaveLength(1);
  });
});
