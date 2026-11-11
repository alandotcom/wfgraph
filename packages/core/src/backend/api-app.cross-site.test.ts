import { describe, expect, it } from "vitest";
import { createApiApp } from "#src/backend/api-app";
import {
  defineWfGraphAuth,
  resolveAuth,
  WfGraphAccess,
} from "#src/backend/lib/http/authorize";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";

const basePath = "/wfgraph/api" as const;
const publicUrl = "https://workflows.example.com";
/** The URL a request reaches the app at behind the host's proxy. */
const internalOrigin = "http://internal:4017";

/**
 * An app whose host authentication counts its calls, so a case can show a
 * refused request never reached the host's session check.
 */
function appWithCountedAuth(runtime: ReturnType<typeof stubWfGraphRuntime>) {
  const calls = { authenticate: 0 };
  const app = createApiApp({
    basePath,
    auth: resolveAuth(
      defineWfGraphAuth(() => {
        calls.authenticate += 1;
        return WfGraphAccess.all;
      })
    ),
    runtime,
  });
  return { app, calls };
}

function post(path: string, headers: Record<string, string>): Request {
  return new Request(`${internalOrigin}${basePath}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });
}

describe("cross-site writes to operator routes", () => {
  it.each([
    {
      name: "a cross-site RPC call",
      path: "/rpc/workflow/delete",
      headers: {
        "sec-fetch-site": "cross-site",
        origin: "https://attacker.example",
      },
    },
    {
      name: "a form posted to REST from a sibling subdomain",
      path: "/rest/workflows",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-site",
        origin: "https://blog.example.com",
      },
    },
    {
      name: "an OAuth start from a sibling subdomain",
      path: "/integrations/oauth/start",
      headers: {
        "sec-fetch-site": "same-site",
        origin: "https://blog.example.com",
      },
    },
    {
      name: "a foreign Origin from a browser that sends no Sec-Fetch-Site",
      path: "/rpc/workflow/delete",
      headers: { origin: "https://attacker.example" },
    },
  ])("refuses $name before host authentication", async ({ path, headers }) => {
    await using runtime = stubWfGraphRuntime({
      appContext: { apiBasePath: basePath, publicUrl },
    });
    const fixture = appWithCountedAuth(runtime);

    const response = await fixture.app.fetch(post(path, headers));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Cross-site request refused",
    });
    expect(fixture.calls.authenticate).toBe(0);
  });

  it.each([
    {
      name: "a same-origin browser call",
      headers: {
        "sec-fetch-site": "same-origin",
        origin: "https://workflows.example.com",
      },
    },
    {
      name: "a same-site call whose Origin is the configured publicUrl",
      headers: { "sec-fetch-site": "same-site", origin: publicUrl },
    },
    {
      name: "a cross-site call whose Origin is the request's own origin",
      headers: { "sec-fetch-site": "cross-site", origin: internalOrigin },
    },
    { name: "a client that sends neither header", headers: {} },
  ])("lets $name through to authentication", async ({ headers }) => {
    await using runtime = stubWfGraphRuntime({
      appContext: { apiBasePath: basePath, publicUrl },
    });
    const fixture = appWithCountedAuth(runtime);

    const response = await fixture.app.fetch(post("/rpc/missing", headers));

    expect(response.status).toBe(404);
    expect(fixture.calls.authenticate).toBe(1);
  });

  it("reads a cross-site GET, which changes nothing", async () => {
    await using runtime = stubWfGraphRuntime({
      appContext: { apiBasePath: basePath, publicUrl },
    });
    const fixture = appWithCountedAuth(runtime);

    const response = await fixture.app.fetch(
      new Request(`${internalOrigin}${basePath}/missing`, {
        headers: {
          "sec-fetch-site": "cross-site",
          origin: "https://attacker.example",
        },
      })
    );

    expect(response.status).toBe(404);
    expect(fixture.calls.authenticate).toBe(1);
  });

  it("leaves webhook intake to the vendor's signature", async () => {
    await using runtime = stubWfGraphRuntime({
      appContext: { apiBasePath: basePath, publicUrl },
    });
    const fixture = appWithCountedAuth(runtime);

    const response = await fixture.app.fetch(
      post("/webhooks/example/conn_1", {
        "sec-fetch-site": "cross-site",
        origin: "https://vendor.example",
      })
    );

    expect(response.status).not.toBe(403);
    expect(fixture.calls.authenticate).toBe(0);
  });
});

describe("OAuth start", () => {
  it("refuses a body that is not sent as JSON", async () => {
    await using runtime = stubWfGraphRuntime({
      appContext: { apiBasePath: basePath, publicUrl },
    });
    const fixture = appWithCountedAuth(runtime);

    const response = await fixture.app.fetch(
      new Request(`${internalOrigin}${basePath}/integrations/oauth/start`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ mode: "reconnect", integrationId: "int_1" }),
      })
    );

    expect(response.status).toBe(415);
  });
});
