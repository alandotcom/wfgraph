import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resend } from "#src/resend/index";

const oauth = resend.oauth;

if (oauth === undefined) {
  throw new Error("Resend must always offer OAuth");
}

const clientContext = {
  publicUrl: "https://workflow.example.com",
  callbackUrl: "https://workflow.example.com/api/oauth/resend/callback",
  metadataDocumentUrl: "https://workflow.example.com/oauth/resend-client.json",
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
  access_token: "eyJhbGciOiJFUzI1NiJ9.access.payload",
  token_type: "Bearer",
  expires_in: 900,
  refresh_token: "refresh-new",
  scope: "emails:send",
};

describe("Resend OAuth registration", () => {
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
        // Both scopes registered, so Resend's consent page offers both and
        // grays out neither.
        scope: "emails:send full_access",
      },
    });
  });

  it("builds an authorization URL with mandatory S256 PKCE", () => {
    const url = oauth.authorize({
      client,
      redirectUri: clientContext.callbackUrl,
      state: "state-value",
      codeChallenge: "challenge-value",
    });

    expect(url.toString()).toBe(
      "https://api.resend.com/oauth/authorize?client_id=https%3A%2F%2Fworkflow.example.com%2Foauth%2Fresend-client.json&response_type=code&redirect_uri=https%3A%2F%2Fworkflow.example.com%2Fapi%2Foauth%2Fresend%2Fcallback&state=state-value&code_challenge=challenge-value&code_challenge_method=S256"
    );
  });

  it("names no scope, leaving the permission to Resend's own consent page", () => {
    const url = oauth.authorize({
      client,
      redirectUri: clientContext.callbackUrl,
      state: "state-value",
      codeChallenge: "challenge-value",
    });

    // An omitted `scope` asks for the client's whole registered set, which is
    // what makes Resend render its Permission chooser with both options live.
    expect(url.searchParams.has("scope")).toBe(false);
  });
});

describe("Resend OAuth token exchange", () => {
  it("posts the authorization-code form and normalizes the token set", async () => {
    stubFetch(() => Response.json(tokenResponse));
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    await expect(
      oauth.exchange({
        client,
        code: "authorization-code",
        redirectUri: clientContext.callbackUrl,
        codeVerifier: "code-verifier",
      })
    ).resolves.toEqual({
      credentials: { RESEND_API_KEY: tokenResponse.access_token },
      grantedAccessLabel: "Sending access",
      tokens: {
        accessToken: tokenResponse.access_token,
        expiresAt: "2023-11-14T22:28:20.000Z",
        refreshToken: "refresh-new",
      },
    });

    const request = requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("https://api.resend.com/oauth/token");
    expect(request?.headers.get("content-type")).toContain(
      "application/x-www-form-urlencoded"
    );
    await expect(form(request as Request)).resolves.toEqual(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.clientId,
        code: "authorization-code",
        redirect_uri: clientContext.callbackUrl,
        code_verifier: "code-verifier",
      })
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

describe("Resend OAuth granted access", () => {
  const grantedFor = async (scope: string) => {
    stubFetch(() => Response.json({ ...tokenResponse, scope }));
    const grant = await oauth.exchange({
      client,
      code: "authorization-code",
      redirectUri: clientContext.callbackUrl,
      codeVerifier: "code-verifier",
    });
    return grant.grantedAccessLabel;
  };

  it("reads full access off the response", async () => {
    await expect(grantedFor("full_access")).resolves.toBe("Full access");
  });

  it("takes the wider scope when the response names both", async () => {
    await expect(grantedFor("emails:send full_access")).resolves.toBe(
      "Full access"
    );
  });

  it("records a refresh that narrowed the grant", async () => {
    stubFetch(() => Response.json({ ...tokenResponse, scope: "emails:send" }));

    await expect(
      oauth.refresh({
        client,
        grant: {
          credentials: { RESEND_API_KEY: "old-access" },
          grantedAccessLabel: "Full access",
          tokens: { accessToken: "old-access", refreshToken: "refresh-old" },
        },
      })
    ).resolves.toMatchObject({ grantedAccessLabel: "Sending access" });
  });

  it("rejects a scope it cannot name, without quoting the response", async () => {
    stubFetch(() =>
      Response.json({ ...tokenResponse, scope: "contacts:read" })
    );

    const result = await oauth
      .exchange({
        client,
        code: "authorization-code",
        redirectUri: clientContext.callbackUrl,
        codeVerifier: "code-verifier",
      })
      .catch((error: unknown) => String(error));

    expect(result).toContain("unrecognized scope");
    expect(result).not.toContain("contacts:read");
    expect(result).not.toContain(tokenResponse.access_token);
  });
});

describe("Resend OAuth refresh and revoke", () => {
  it("rotates the refresh token in one normalized result", async () => {
    stubFetch(() => Response.json(tokenResponse));

    await expect(
      oauth.refresh({
        client,
        grant: {
          credentials: { RESEND_API_KEY: "old-access" },
          tokens: {
            accessToken: "old-access",
            refreshToken: "refresh-old",
          },
        },
      })
    ).resolves.toEqual({
      credentials: { RESEND_API_KEY: tokenResponse.access_token },
      grantedAccessLabel: "Sending access",
      tokens: {
        accessToken: tokenResponse.access_token,
        expiresAt: expect.any(String),
        refreshToken: tokenResponse.refresh_token,
      },
    });

    await expect(form(requests[0] as Request)).resolves.toEqual(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: "refresh-old",
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
          credentials: { RESEND_API_KEY: "old-access" },
          tokens: { accessToken: "old-access", refreshToken: "refresh-old" },
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
          credentials: { RESEND_API_KEY: "access-token" },
          tokens: { accessToken: "access-token", refreshToken: "refresh-old" },
        },
      })
    ).resolves.toBeUndefined();

    const request = requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("https://api.resend.com/oauth/revoke");
    await expect(form(request as Request)).resolves.toEqual(
      new URLSearchParams({
        client_id: client.clientId,
        token: "refresh-old",
        token_type_hint: "refresh_token",
      })
    );
  });

  it("does not retry revocation and keeps token values out of errors", async () => {
    const refreshToken = "refresh-secret";
    const accessToken = "access-secret";
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
          credentials: { RESEND_API_KEY: accessToken },
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
