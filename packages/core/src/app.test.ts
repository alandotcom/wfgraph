import { describe, expect, it } from "bun:test";
import { createRovaApp, type RovaApp } from "@/app";

// createRovaApp opens no connections: the database client is lazy and
// migrations only run when asked. Every route exercised below answers from
// process memory, so these tests need no Postgres and no Inngest.
const BASE_OPTIONS = {
  database: { url: "postgresql://rova:rova@127.0.0.1:1/rova_test" },
  encryption: { key: "a".repeat(64) },
  inngest: { client: { id: "rova-app-test" } },
  configureLogging: false,
  serveClient: false,
} as const;

async function createTestApp(basePath?: string): Promise<RovaApp> {
  return await createRovaApp({ ...BASE_OPTIONS, basePath });
}

function get(app: RovaApp, path: string): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`));
}

describe("createRovaApp mounted at the root", () => {
  it("serves the API off /api", async () => {
    const app = await createTestApp();
    try {
      const response = await get(app, "/api/extensions");

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        actions: expect.any(Array),
        triggers: expect.any(Array),
      });
    } finally {
      app.dispose();
    }
  });
});

describe("createRovaApp mounted under a sub-path", () => {
  it("serves the API off the mount point", async () => {
    const app = await createTestApp("/rova");
    try {
      expect((await get(app, "/rova/api/extensions")).status).toBe(200);
    } finally {
      app.dispose();
    }
  });

  it("does not answer on the unmounted path", async () => {
    const app = await createTestApp("/rova");
    try {
      expect((await get(app, "/api/extensions")).status).toBe(404);
    } finally {
      app.dispose();
    }
  });

  it("matches oRPC procedures under the mounted prefix", async () => {
    const app = await createTestApp("/rova");
    try {
      // An empty body fails the procedure's input validation. Reaching that
      // validation at all is the signal: an unmatched prefix would fall through
      // to the app's own 404 instead.
      const response = await app.fetch(
        new Request("http://localhost/rova/api/rpc/workflow/getById", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: {} }),
        })
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Input validation failed");
    } finally {
      app.dispose();
    }
  });

  it("advertises the mounted REST path in the OpenAPI document", async () => {
    const app = await createTestApp("/rova");
    try {
      const response = await get(app, "/rova/api/openapi.json");

      expect(response.status).toBe(200);
      // What the docs panel's "Try it" button and every generated client aim
      // at. A hardcoded "/api/rest" here 404s under a sub-path mount.
      expect(await response.json()).toMatchObject({
        servers: [{ url: "/rova/api/rest" }],
      });
    } finally {
      app.dispose();
    }
  });

  it("routes SPA paths through the client handler rather than 404ing them", async () => {
    const app = await createRovaApp({
      ...BASE_OPTIONS,
      basePath: "/rova",
      serveClient: true,
    });
    try {
      // 503 when no client has been built, 200 when one has. Either answer
      // proves the request reached the client handler; a path outside the mount
      // never does.
      expect([200, 503]).toContain((await get(app, "/rova/")).status);
      expect([200, 503]).toContain(
        (await get(app, "/rova/workflows/abc")).status
      );
      expect((await get(app, "/elsewhere/workflows/abc")).status).toBe(404);
    } finally {
      app.dispose();
    }
  });

  it("refuses a basePath that could escape the mount", async () => {
    await expect(createTestApp("/rova/../admin")).rejects.toThrow(
      "unusable basePath"
    );
  });
});
