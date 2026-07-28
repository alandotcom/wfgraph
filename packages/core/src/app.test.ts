import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createTrigger } from "#src/index";
import { createRovaApp, type RovaApp } from "#src/app";
import { createApiApp, MACHINE_ROUTES } from "#src/backend/api-app";
import { createRovaRuntime } from "#src/backend/runtime";

// createRovaApp opens no connections: the database client is lazy and
// migrations only run when asked. Every route exercised below answers from
// process memory, so these tests need no Postgres and no Inngest.
const BASE_OPTIONS = {
  auth: "external",
  database: { url: "postgresql://rova:rova@127.0.0.1:1/rova_test" },
  encryption: { key: "a".repeat(64) },
  inngest: { id: "rova-app-test", isDev: true },
  configureLogging: false,
} as const;

async function createTestApp(basePath?: string): Promise<RovaApp> {
  return await createRovaApp({ ...BASE_OPTIONS, basePath });
}

// A stand-in for @rova/client: what the server needs is a directory with an
// index.html, and building the real SPA to assert routing would be beside the
// point.
let clientDir: string;

beforeAll(async () => {
  clientDir = await mkdtemp(join(tmpdir(), "rova-client-"));
  await writeFile(
    join(clientDir, "index.html"),
    '<!doctype html><html><head><base href="/" /></head><body></body></html>'
  );
});

afterAll(async () => {
  await rm(clientDir, { recursive: true, force: true });
});

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
      await app.dispose();
    }
  });
});

describe("createRovaApp mounted under a sub-path", () => {
  it("serves the API off the mount point", async () => {
    const app = await createTestApp("/rova");
    try {
      expect((await get(app, "/rova/api/extensions")).status).toBe(200);
    } finally {
      await app.dispose();
    }
  });

  it("does not answer on the unmounted path", async () => {
    const app = await createTestApp("/rova");
    try {
      expect((await get(app, "/api/extensions")).status).toBe(404);
    } finally {
      await app.dispose();
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
      await app.dispose();
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
      await app.dispose();
    }
  });

  it("serves the editor a host handed it, under the mount", async () => {
    const app = await createRovaApp({
      ...BASE_OPTIONS,
      basePath: "/rova",
      client: { dir: clientDir },
    });
    try {
      const index = await get(app, "/rova/workflows/abc");
      expect(index.status).toBe(200);
      expect(await index.text()).toContain('<base href="/rova/" />');
      expect((await get(app, "/elsewhere/workflows/abc")).status).toBe(404);
    } finally {
      await app.dispose();
    }
  });

  // No bundle passed, no editor: the option is the switch.
  it("serves no editor when the host hands it none", async () => {
    const app = await createTestApp("/rova");
    try {
      expect((await get(app, "/rova/")).status).toBe(404);
    } finally {
      await app.dispose();
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
    client?: { dir: string }
  ): Promise<RovaApp> {
    return await createRovaApp({
      ...BASE_OPTIONS,
      basePath: "/rova",
      client,
      auth: () => allow,
    });
  }

  /**
   * Read off the app itself, so a route added to createApiApp without a thought
   * for the gate fails here rather than shipping open.
   */
  async function listGatedPaths(): Promise<string[]> {
    // Only the route table is read here. A runtime builds its Layers on the
    // first Effect it runs and this app never serves a request, so this one is
    // disposed having built nothing.
    const runtime = createRovaRuntime();
    try {
      const app = createApiApp({
        basePath: "/rova/api",
        authorize: () => Promise.resolve(true),
        runtime,
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
    } finally {
      await runtime.dispose();
    }
  }

  /** Fill in Hono's `:param` and `*` segments so a request can be made. */
  function toRequestPath(path: string): string {
    return path.replace(/:[^/]+/g, "x").replace(/\*/g, "x");
  }

  it("refuses every non-machine path when the host says no", async () => {
    const app = await createGuardedApp(false);
    const paths = await listGatedPaths();

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
      await app.dispose();
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
      await app.dispose();
    }
  });

  it("refuses the editor itself, not only its data", async () => {
    const app = await createGuardedApp(false, { dir: clientDir });
    try {
      for (const path of ["/rova/", "/rova/workflows/abc"]) {
        expect((await get(app, path)).status).toBe(401);
      }
    } finally {
      await app.dispose();
    }
  });

  it("lets everything through when the host says yes", async () => {
    const app = await createGuardedApp(true, { dir: clientDir });
    try {
      expect((await get(app, "/rova/api/extensions")).status).toBe(200);
      expect((await get(app, "/rova/api/openapi.json")).status).toBe(200);
      expect((await get(app, "/rova/")).status).toBe(200);
    } finally {
      await app.dispose();
    }
  });
});

describe("createRovaApp configuration", () => {
  // Integration credentials are stored encrypted, so a missing or malformed key
  // has to stop startup rather than surface later as a failing integration read.
  it("refuses to start without an encryption key", async () => {
    await expect(
      createRovaApp({ ...BASE_OPTIONS, encryption: { key: undefined } })
    ).rejects.toThrow("encryption.key is unset");
  });

  // A host reading the key from an environment variable that is set to nothing
  // has the same problem as one that never set it, and gets the same message.
  it("treats a blank encryption key as unset", async () => {
    await expect(
      createRovaApp({ ...BASE_OPTIONS, encryption: { key: "  " } })
    ).rejects.toThrow("encryption.key is unset");
  });

  it("refuses an encryption key of the wrong length", async () => {
    await expect(
      createRovaApp({ ...BASE_OPTIONS, encryption: { key: "abc123" } })
    ).rejects.toThrow("64-character hex string");
  });

  // The database handle, the Inngest client, and both registries are process
  // globals. A second app on a different database used to alias the first
  // connection and surface later as rows in the wrong place.
  it("refuses a second app configured differently", async () => {
    const app = await createTestApp();
    try {
      await expect(
        createRovaApp({
          ...BASE_OPTIONS,
          database: { url: "postgresql://other:other@127.0.0.1:1/other" },
        })
      ).rejects.toThrow("already running in this process");
    } finally {
      await app.dispose();
    }
  });

  it("names the fields that disagree", async () => {
    const app = await createTestApp();
    try {
      await expect(
        createRovaApp({
          ...BASE_OPTIONS,
          inngest: { id: "someone-else", isDev: true },
        })
      ).rejects.toThrow("inngestClientId");
    } finally {
      await app.dispose();
    }
  });

  it("releases the claim when startup fails after taking it", async () => {
    await expect(
      createRovaApp({
        ...BASE_OPTIONS,
        // A trigger type that is already built in, so registration throws well
        // after the process has been claimed.
        triggers: [
          createTrigger({
            type: "Webhook",
            label: "Clashing",
            description: "Collides with the built-in webhook trigger",
            schema: z.object({ id: z.string(), event: z.string() }),
            correlationIdPath: "id",
            eventTypePath: "event",
          }),
        ],
      })
    ).rejects.toThrow("already registered");

    // A claim left behind would answer this with "an app is already running"
    // and bury whatever the operator actually needs to fix.
    const app = await createRovaApp({
      ...BASE_OPTIONS,
      inngest: { id: "after-failed-startup", isDev: true },
    });
    await app.dispose();
  });

  // Two apps of one identity are allowed, so the claim is counted. A flag would
  // let the first dispose hand the process to a third app on another database
  // while the second is still serving.
  it("holds the claim until the last app disposes", async () => {
    const first = await createTestApp();
    const second = await createTestApp();

    await first.dispose();

    await expect(
      createRovaApp({
        ...BASE_OPTIONS,
        database: { url: "postgresql://other:other@127.0.0.1:1/other" },
      })
    ).rejects.toThrow("already running in this process");

    await second.dispose();
  });

  // Registering a trigger type twice throws, so a second app carrying the same
  // trigger only starts if dispose gave the first one's registrations back.
  it("releases its registrations on dispose", async () => {
    const trigger = createTrigger({
      type: "DisposeProbe",
      label: "Dispose Probe",
      description: "Registered twice, on purpose",
      schema: z.object({ id: z.string(), event: z.string() }),
      correlationIdPath: "id",
      eventTypePath: "event",
    });

    const first = await createRovaApp({ ...BASE_OPTIONS, triggers: [trigger] });
    await first.dispose();

    const second = await createRovaApp({
      ...BASE_OPTIONS,
      triggers: [trigger],
    });
    try {
      const extensions = (await (
        await get(second, "/api/extensions")
      ).json()) as { triggers: Array<{ type: string }> };

      expect(extensions.triggers.map((entry) => entry.type)).toContain(
        "DisposeProbe"
      );
    } finally {
      await second.dispose();
    }
  });
});
