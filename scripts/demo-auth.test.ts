import { describe, expect, it } from "vitest";
import { createDemoAuth } from "../examples/demo-auth";

const ORIGIN = "http://example.test";

type DemoAuth = ReturnType<typeof createDemoAuth>;

function request(path: string, init?: RequestInit): Request {
  return new Request(new URL(path, ORIGIN), init);
}

function cookieHeader(token: string): string {
  return `wfgraph_session=${token}`;
}

function sessionCookie(response: Response): string {
  const match = response.headers
    .get("set-cookie")
    ?.match(/^wfgraph_session=([^;]+);/);
  if (!match) throw new Error("The response did not set a session cookie");
  return match[1];
}

async function fetchRoute(
  auth: DemoAuth,
  path: string,
  init?: RequestInit
): Promise<Response> {
  return auth.createFetch(
    async () => new Response("unhandled", { status: 500 })
  )(request(path, init));
}

async function sessionStatus(auth: DemoAuth, token?: string): Promise<number> {
  return (
    await fetchRoute(
      auth,
      "/login/session",
      token ? { headers: { cookie: cookieHeader(token) } } : undefined
    )
  ).status;
}

async function login(
  auth: DemoAuth,
  username = "admin",
  password = "password",
  headers?: HeadersInit
): Promise<Response> {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", "application/x-www-form-urlencoded");
  return fetchRoute(auth, "/login", {
    method: "POST",
    headers: requestHeaders,
    body: new URLSearchParams({ username, password }),
  });
}

describe("example demo auth", () => {
  it("serves the login document and rejects invalid form credentials", async () => {
    const auth = createDemoAuth({ isProduction: false });

    const page = await fetchRoute(auth, "/login");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Sign in to the example app");

    const invalid = await login(auth, "admin", "wrong-password");
    expect(invalid.status).toBe(401);
    expect(await invalid.text()).toContain("username or password is incorrect");
  });

  it.each([
    { isProduction: false, secure: false },
    { isProduction: true, secure: true },
  ])(
    "sets the expected session cookie attributes in production=$isProduction",
    async ({ isProduction, secure }) => {
      const auth = createDemoAuth({ isProduction });
      const response = await login(auth);
      const setCookie = response.headers.get("set-cookie") ?? "";

      expect(response.status).toBe(303);
      expect(setCookie).toMatch(/; HttpOnly/);
      expect(setCookie).toContain("; SameSite=Lax");
      expect(setCookie).toContain("; Path=/");
      if (secure) {
        expect(setCookie).toMatch(/; Secure(?:;|$)/);
      } else {
        expect(setCookie).not.toMatch(/; Secure(?:;|$)/);
      }
    }
  );

  it("probes an authenticated session and invalidates replaced and logged-out sessions", async () => {
    const auth = createDemoAuth({ isProduction: false });
    const firstLogin = await login(auth);
    const firstToken = sessionCookie(firstLogin);

    expect(await sessionStatus(auth)).toBe(401);
    expect(await sessionStatus(auth, firstToken)).toBe(204);

    const replacement = await login(auth, "editor", "password", {
      cookie: cookieHeader(firstToken),
    });
    const replacementToken = sessionCookie(replacement);
    expect(replacementToken).not.toBe(firstToken);
    expect(await sessionStatus(auth, firstToken)).toBe(401);

    const getLogout = await fetchRoute(auth, "/logout", {
      headers: { cookie: cookieHeader(replacementToken) },
    });
    expect(getLogout.status).toBe(404);
    expect(await sessionStatus(auth, replacementToken)).toBe(204);

    const logout = await fetchRoute(auth, "/logout", {
      method: "POST",
      headers: { cookie: cookieHeader(replacementToken) },
    });
    expect(logout.status).toBe(303);
    expect(await sessionStatus(auth, replacementToken)).toBe(401);
  });

  it("fails closed for malformed and duplicate session cookies", async () => {
    const auth = createDemoAuth({ isProduction: false });
    const token = sessionCookie(await login(auth));

    for (const cookie of [
      `wfgraph_session=${token}!`,
      `${cookieHeader(token)}; ${cookieHeader(token)}`,
    ]) {
      const response = await fetchRoute(auth, "/login/session", {
        headers: { cookie },
      });
      expect(response.status).toBe(401);
    }
  });

  it("rejects cross-origin login and logout requests", async () => {
    const auth = createDemoAuth({ isProduction: false });
    const response = await login(auth, "admin", "password", {
      origin: "https://evil.example",
    });

    expect(response.status).toBe(403);
    expect(await sessionStatus(auth)).toBe(401);

    const token = sessionCookie(await login(auth));
    const logout = await fetchRoute(auth, "/logout", {
      method: "POST",
      headers: {
        cookie: cookieHeader(token),
        origin: "https://evil.example",
      },
    });
    expect(logout.status).toBe(403);
    expect(await sessionStatus(auth, token)).toBe(204);
  });

  it("redirects document 401 responses while preserving API JSON 401 responses", async () => {
    const wfgraphFetch = async () =>
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    const auth = createDemoAuth({ isProduction: false });

    const document = await auth.createFetch(wfgraphFetch)(
      request("/workflows", { headers: { accept: "text/html" } })
    );
    const api = await auth.createFetch(wfgraphFetch)(
      request("/api/workflows", { headers: { accept: "text/html" } })
    );

    expect(document.status).toBe(302);
    expect(document.headers.get("location")).toBe(`${ORIGIN}/login`);
    expect(api.status).toBe(401);
    expect(api.headers.get("content-type")).toContain("application/json");
    expect(await api.text()).toBe(JSON.stringify({ error: "unauthorized" }));
  });
});
