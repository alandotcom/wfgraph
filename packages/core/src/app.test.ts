import { describe, expect, it } from "bun:test";
import { createRovaApp, type RovaApp } from "@/app";
import { createApiApp, MACHINE_ROUTES } from "@/backend/api-app";

// createRovaApp opens no connections: the database client is lazy and
// migrations only run when asked. Every route exercised below answers from
// process memory, so these tests need no Postgres and no Inngest.
const BASE_OPTIONS = {
  auth: "external",
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

describe("createRovaApp with an auth predicate", () => {
  async function createGuardedApp(
    allow: boolean,
    serveClient = false
  ): Promise<RovaApp> {
    return await createRovaApp({
      ...BASE_OPTIONS,
      basePath: "/rova",
      serveClient,
      auth: () => allow,
    });
  }

  /**
   * Read off the app itself, so a route added to createApiApp without a thought
   * for the gate fails here rather than shipping open.
   */
  function listGatedPaths(): string[] {
    const app = createApiApp({
      basePath: "/rova/api",
      authorize: () => Promise.resolve(true),
    });
    const machinePaths = new Set(
      MACHINE_ROUTES.map((route) => `/rova/api${route}`)
    );

    return [
      ...new Set(
        app.routes
          .map((route) => route.path)
          .filter((path) => !machinePaths.has(path))
      ),
    ];
  }

  /** Fill in Hono's `:param` and `*` segments so a request can be made. */
  function toRequestPath(path: string): string {
    return path.replace(/:[^/]+/g, "x").replace(/\*/g, "x");
  }

  it("refuses every non-machine path when the host says no", async () => {
    const app = await createGuardedApp(false);
    const paths = listGatedPaths();

    try {
      expect(paths.length).toBeGreaterThan(8);

      for (const path of paths) {
        for (const method of ["GET", "POST"]) {
          const response = await app.fetch(
            new Request(`http://localhost${toRequestPath(path)}`, {
              method,
              headers: { "content-type": "application/json" },
              body: method === "GET" ? undefined : "{}",
            })
          );

          expect({ path, method, status: response.status }).toEqual({
            path,
            method,
            status: 401,
          });
        }
      }
    } finally {
      app.dispose();
    }
  });

  it("leaves the machine routes on their own credentials", async () => {
    const app = await createGuardedApp(false);
    try {
      const webhook = await app.fetch(
        new Request("http://localhost/rova/api/workflows/wf_1/webhook", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(["wrong", "shape"]),
        })
      );
      // 400 from the route's own body validation, so the request got past the
      // gate rather than being turned away at it.
      expect(webhook.status).toBe(400);

      const preflight = await app.fetch(
        new Request("http://localhost/rova/api/workflows/wf_1/webhook", {
          method: "OPTIONS",
        })
      );
      expect(preflight.status).toBe(200);

      // Inngest cannot carry a browser session, so a gate here would break every
      // callback and with it every workflow run.
      const inngest = await get(app, "/rova/api/inngest");
      expect(inngest.status).not.toBe(401);
    } finally {
      app.dispose();
    }
  });

  it("refuses the editor itself, not only its data", async () => {
    const app = await createGuardedApp(false, true);
    try {
      for (const path of ["/rova/", "/rova/workflows/abc"]) {
        expect((await get(app, path)).status).toBe(401);
      }
    } finally {
      app.dispose();
    }
  });

  it("lets everything through when the host says yes", async () => {
    const app = await createGuardedApp(true, true);
    try {
      expect((await get(app, "/rova/api/extensions")).status).toBe(200);
      expect((await get(app, "/rova/api/openapi.json")).status).toBe(200);
      expect([200, 503]).toContain((await get(app, "/rova/")).status);
    } finally {
      app.dispose();
    }
  });
});

describe("createRovaApp configuration", () => {
  // Integration credentials are stored encrypted, so a missing or malformed key
  // has to stop startup rather than surface later as a failing integration read.
  it("refuses to start without an encryption key", async () => {
    await expect(
      createRovaApp({ ...BASE_OPTIONS, encryption: { key: "  " } })
    ).rejects.toThrow("requires encryption.key");
  });

  it("refuses an encryption key of the wrong length", async () => {
    await expect(
      createRovaApp({ ...BASE_OPTIONS, encryption: { key: "abc123" } })
    ).rejects.toThrow("64-character hex string");
  });
});
