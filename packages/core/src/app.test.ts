import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { createTrigger, defineEvent } from "#src/index";
import { createRovaApp, type RovaApp } from "#src/app";
import { createApiApp, MACHINE_ROUTES } from "#src/backend/api-app";
import { getInngestFunctions } from "#src/backend/lib/inngest/functions";
import { createRovaRuntime } from "#src/backend/runtime";

// The function registry reads the workflows table to decide which Inngest
// functions exist. Which functions it builds is beside the point here, so the
// query answers nothing and the connection is never opened; vitest scopes a
// mock to the file that declares it.
vi.mock("#src/backend/lib/db/index", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/backend/lib/db/index")>()),
  db: { query: { workflows: { findMany: () => Promise.resolve([]) } } },
}));

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
        // The catalog is the one channel the editor learns the surface through,
        // so an app that starts serves all three of its lists.
        catalog: {
          events: expect.any(Array),
          actions: expect.any(Array),
          integrations: expect.any(Array),
        },
      });
    } finally {
      await app.dispose();
    }
  });

  it("serves the Events the host defined", async () => {
    const app = await createRovaApp({
      ...BASE_OPTIONS,
      extensions: {
        events: [
          defineEvent({
            name: "app/appointment.created",
            label: "Appointment created",
            schema: Schema.Struct({
              appointment: Schema.Struct({
                id: Schema.String.annotate({ description: "Appointment ID" }),
              }).annotate({ description: "The appointment" }),
            }),
            correlationPath: "appointment.id",
          }),
        ],
      },
    });

    try {
      const payload = (await (await get(app, "/api/extensions")).json()) as {
        catalog: { events: Array<{ name: string }> };
      };

      expect(payload.catalog.events.map((event) => event.name)).toEqual([
        "app/appointment.created",
      ]);
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
      const intake = await app.fetch(
        new Request("http://localhost/rova/api/events/order.created", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(["wrong", "shape"]),
        })
      );
      // 400 from the route's own body validation, so the request got past the
      // gate rather than being turned away at it.
      expect(intake.status).toBe(400);

      const preflight = await app.fetch(
        new Request("http://localhost/rova/api/events/order.created", {
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

  // Every other answer the event intake route gives carries CORS, including the
  // 500 built by onError, so a body the route refuses before the service is
  // reached has to as well. Without it a browser-side sender sees an opaque
  // response and cannot tell a malformed request from an outage.
  it("carries CORS on the intake refusals the route makes itself", async () => {
    const app = await createGuardedApp(false);
    try {
      const badBody = await app.fetch(
        new Request("http://localhost/rova/api/events/order.created", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(["wrong", "shape"]),
        })
      );
      expect(badBody.status).toBe(400);
      expect(badBody.headers.get("Access-Control-Allow-Origin")).toBe("*");

      // A path segment of nothing but whitespace is the one way the Event name
      // fails its own schema, since Hono never matches an empty segment.
      const badParams = await app.fetch(
        new Request("http://localhost/rova/api/events/%20", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      );
      expect(badParams.status).toBe(400);
      expect(badParams.headers.get("Access-Control-Allow-Origin")).toBe("*");
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

  // The option sits under `database` now, beside the connection it applies to. A
  // directory that is not there is the cheapest proof that it was read at all:
  // startup migrations look for the folder before they open a connection.
  it("takes startup migrations from database.migrations", async () => {
    await expect(
      createRovaApp({
        ...BASE_OPTIONS,
        database: {
          ...BASE_OPTIONS.database,
          migrations: { runOnStartup: true, migrationsDir: "no-such-folder" },
        },
      })
    ).rejects.toThrow("Migrations folder not found");
  });

  it("leaves the database alone when startup migrations go unasked for", async () => {
    const app = await createRovaApp({
      ...BASE_OPTIONS,
      database: {
        ...BASE_OPTIONS.database,
        migrations: { migrationsDir: "no-such-folder" },
      },
    });

    await app.dispose();
  });

  it("refuses an encryption key of the wrong length", async () => {
    await expect(
      createRovaApp({ ...BASE_OPTIONS, encryption: { key: "abc123" } })
    ).rejects.toThrow("64-character hex string");
  });

  // The cached Inngest functions close over the runtime the app owns, so a
  // second app served the first one's array would be running event listeners on
  // a finalized runtime. Dispose dropping the cache is what prevents it, and
  // identity is how that shows: a rebuild answers a new array.
  it("rebuilds the Inngest registry after an app is disposed", async () => {
    const first = await createTestApp();
    const firstRuntime = createRovaRuntime();
    const secondRuntime = createRovaRuntime();

    try {
      const built = await getInngestFunctions(firstRuntime);
      // Within its short TTL the registry answers the same array, which is what
      // makes the comparison below mean something.
      expect(await getInngestFunctions(firstRuntime)).toBe(built);

      await first.dispose();

      const second = await createTestApp();
      try {
        expect(await getInngestFunctions(secondRuntime)).not.toBe(built);
      } finally {
        await second.dispose();
      }
    } finally {
      await firstRuntime.dispose();
      await secondRuntime.dispose();
    }
  });

  // Registering a trigger type twice throws, so a second app carrying the same
  // trigger only starts if dispose gave the first one's registrations back.
  it("releases its registrations on dispose", async () => {
    const trigger = createTrigger({
      type: "DisposeProbe",
      label: "Dispose Probe",
      description: "Registered twice, on purpose",
      schema: Schema.Struct({ id: Schema.String, event: Schema.String }),
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
