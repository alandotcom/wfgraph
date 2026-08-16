import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { defineAction, defineEvent } from "#src/index";
import { defineIntegration } from "#src/backend/extensions/define-integration";
import { createWfGraphApp, type WfGraphApp } from "#src/app";
import { createApiApp, machineRoutes } from "#src/backend/api-app";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { connect as connectInngestSdk } from "inngest/connect";
import { createInngestSurface } from "#src/backend/lib/inngest/client";
import * as inngestClientModule from "#src/backend/lib/inngest/client";
import { buildInngestFunctions } from "#src/backend/lib/inngest/functions";
import { createWfGraphRuntime } from "#src/backend/runtime";
import { makePostgresRepositories } from "#src/backend/persistence/postgres-repositories";
import { normalizeDatabaseConfig } from "#src/backend/lib/db/config";
import * as dbModule from "#src/backend/lib/db/index";
import { createIntegrationCipher } from "#src/backend/services/integrations/cipher";
import { wfPostgres } from "#src/backend/persistence/postgres";

// createWfGraphApp opens no connections: the database client is lazy and
// migrations only run when asked. Every route exercised below answers from
// process memory, so these tests need no Postgres and no Inngest.
const BASE_OPTIONS = {
  auth: "external",
  persistence: wfPostgres({
    url: "postgresql://wfgraph:wfgraph@127.0.0.1:1/wfgraph_test",
  }),
  encryption: { key: "a".repeat(64) },
  inngest: { id: "wfgraph-app-test", isDev: true },
} as const;

async function createTestApp(basePath?: string): Promise<WfGraphApp> {
  return await createWfGraphApp({ ...BASE_OPTIONS, basePath });
}

// A stand-in for @wfgraph/client: what the server needs is a directory with an
// index.html, and building the real SPA to assert routing would be beside the
// point.
let clientDir: string;

beforeAll(async () => {
  clientDir = await mkdtemp(join(tmpdir(), "wfgraph-client-"));
  await writeFile(
    join(clientDir, "index.html"),
    '<!doctype html><html><head><base href="/" /></head><body></body></html>'
  );
});

afterAll(async () => {
  await rm(clientDir, { recursive: true, force: true });
});

function get(app: WfGraphApp, path: string): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`));
}

describe("createWfGraphApp mounted at the root", () => {
  it("serves the API off /api", async () => {
    const app = await createTestApp();
    try {
      const response = await get(app, "/api/extensions");
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        // The catalog is the one channel the editor learns the surface through,
        // so an app that starts serves all three of its lists.
        catalog: {
          events: expect.any(Array),
          actions: expect.any(Array),
          integrations: expect.any(Array),
        },
      });
      // And it is the whole envelope. The browser reads this one member, so a
      // second one here would be a surface the editor never sees.
      expect(Object.keys(payload as object)).toEqual(["catalog"]);
    } finally {
      await app.dispose();
    }
  });

  it("serves the integrations the host passed, actions and all", async () => {
    const app = await createWfGraphApp({
      ...BASE_OPTIONS,
      extensions: {
        integrations: [
          defineIntegration({
            type: "twilio",
            label: "Twilio",
            description: "Send SMS messages",
            credentials: {
              TWILIO_AUTH_TOKEN: { label: "Auth Token", type: "password" },
            },
            actions: {
              "send-sms": {
                label: "Send SMS",
                description: "Sends a message",
                input: Schema.Struct({ smsTo: Schema.String }),
                output: Schema.Struct({
                  sid: Schema.String.annotate({ description: "Message SID" }),
                }),
                configFields: [
                  {
                    key: "smsTo",
                    label: "To",
                    type: "template-input",
                    required: true,
                  },
                ],
                handler: Effect.fn(function* () {
                  return yield* Effect.succeed({ sid: "SM1" });
                }),
              },
            },
          }),
        ],
      },
    });

    try {
      const payload = (await (await get(app, "/api/extensions")).json()) as {
        catalog: {
          actions: Array<{ id: string; outputFields: unknown }>;
          integrations: Array<{ type: string; hasTest: boolean }>;
        };
      };

      // The engine ships no integration of its own, so the catalog holds exactly
      // what this host passed under extensions.integrations.
      expect(payload.catalog.integrations).toEqual([
        expect.objectContaining({ type: "twilio", hasTest: false }),
      ]);
      // The id is computed from the type and the record key, and the field list
      // is derived from the output schema, so neither is written by the host.
      expect(
        payload.catalog.actions.find(
          (action) => action.id === "twilio/send-sms"
        )
      ).toEqual(
        expect.objectContaining({
          outputFields: [
            { path: "sid", description: "Message SID", type: "string" },
          ],
        })
      );
    } finally {
      await app.dispose();
    }
  });

  it("serves the Events the host defined", async () => {
    const app = await createWfGraphApp({
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

describe("createWfGraphApp mounted under a sub-path", () => {
  it("serves the API off the mount point", async () => {
    const app = await createTestApp("/wfgraph");
    try {
      expect((await get(app, "/wfgraph/api/extensions")).status).toBe(200);
    } finally {
      await app.dispose();
    }
  });

  it("does not answer on the unmounted path", async () => {
    const app = await createTestApp("/wfgraph");
    try {
      expect((await get(app, "/api/extensions")).status).toBe(404);
    } finally {
      await app.dispose();
    }
  });

  it("matches oRPC procedures under the mounted prefix", async () => {
    const app = await createTestApp("/wfgraph");
    try {
      // An empty body fails the procedure's input validation. Reaching that
      // validation at all is the signal: an unmatched prefix would fall through
      // to the app's own 404 instead.
      const response = await app.fetch(
        new Request("http://localhost/wfgraph/api/rpc/workflow/getById", {
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
    const app = await createTestApp("/wfgraph");
    try {
      const response = await get(app, "/wfgraph/api/openapi.json");

      expect(response.status).toBe(200);
      // What the docs panel's "Try it" button and every generated client aim
      // at. A hardcoded "/api/rest" here 404s under a sub-path mount.
      expect(await response.json()).toMatchObject({
        servers: [{ url: "/wfgraph/api/rest" }],
      });
    } finally {
      await app.dispose();
    }
  });

  it("serves the editor a host handed it, under the mount", async () => {
    const app = await createWfGraphApp({
      ...BASE_OPTIONS,
      basePath: "/wfgraph",
      client: { dir: clientDir },
    });
    try {
      const index = await get(app, "/wfgraph/workflows/abc");
      expect(index.status).toBe(200);
      expect(await index.text()).toContain('<base href="/wfgraph/" />');
      expect((await get(app, "/elsewhere/workflows/abc")).status).toBe(404);
    } finally {
      await app.dispose();
    }
  });

  // No bundle passed, no editor: the option is the switch.
  it("serves no editor when the host hands it none", async () => {
    const app = await createTestApp("/wfgraph");
    try {
      expect((await get(app, "/wfgraph/")).status).toBe(404);
    } finally {
      await app.dispose();
    }
  });

  it("refuses a basePath that could escape the mount", async () => {
    await expect(createTestApp("/wfgraph/../admin")).rejects.toThrow(
      "unusable basePath"
    );
  });
});

describe("createWfGraphApp with an auth predicate", () => {
  async function createGuardedApp(
    allow: boolean,
    client?: { dir: string }
  ): Promise<WfGraphApp> {
    return await createWfGraphApp({
      ...BASE_OPTIONS,
      basePath: "/wfgraph",
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
    const inngest = createInngestSurface(BASE_OPTIONS.inngest, {
      connect: connectInngestSdk,
    });
    const database = dbModule.createDatabaseSurface(
      normalizeDatabaseConfig({
        url: "postgresql://wfgraph:wfgraph@127.0.0.1:1/wfgraph_test",
      })
    );
    const runtime = createWfGraphRuntime({
      inngest,
      extensions: assembleExtensions({}),
      repositories: makePostgresRepositories(
        database,
        createIntegrationCipher(BASE_OPTIONS.encryption)
      ),
    });
    try {
      const app = createApiApp({
        basePath: "/wfgraph/api",
        authorize: () => Promise.resolve(true),
        runtime,
        inngestHandler: inngest.serve(
          await buildInngestFunctions(inngest.client, runtime)
        ),
      });
      const machinePaths = new Set(
        machineRoutes({ serveInngest: true }).map(
          (route) => `/wfgraph/api${route}`
        )
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
      await database.close();
    }
  }

  /** Fill in Hono's `:param` and `*` segments so a request can be made. */
  function toRequestPath(path: string): string {
    return path.replace(/:[^/]+/g, "x").replace(/\*/g, "x");
  }

  it("refuses every non-machine path when the host says no", async () => {
    // Read the route table before opening the guarded app; this helper owns and
    // disposes a complete runtime even though no route executes against it.
    const paths = await listGatedPaths();
    const app = await createGuardedApp(false);

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
      const resume = await app.fetch(
        new Request(
          "http://localhost/wfgraph/api/workflows/waits/tok_1/resume",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(["wrong", "shape"]),
          }
        )
      );
      // 400 from the route's own body validation, so the request got past the
      // gate rather than being turned away at it.
      expect(resume.status).toBe(400);

      // Inngest cannot carry a browser session, so a gate here would break every
      // callback and with it every workflow run.
      const inngest = await get(app, "/wfgraph/api/inngest");
      expect(inngest.status).not.toBe(401);
    } finally {
      await app.dispose();
    }
  });

  it("refuses the editor itself, not only its data", async () => {
    const app = await createGuardedApp(false, { dir: clientDir });
    try {
      for (const path of ["/wfgraph/", "/wfgraph/workflows/abc"]) {
        expect((await get(app, path)).status).toBe(401);
      }
    } finally {
      await app.dispose();
    }
  });

  it("lets everything through when the host says yes", async () => {
    const app = await createGuardedApp(true, { dir: clientDir });
    try {
      expect((await get(app, "/wfgraph/api/extensions")).status).toBe(200);
      expect((await get(app, "/wfgraph/api/openapi.json")).status).toBe(200);
      expect((await get(app, "/wfgraph/")).status).toBe(200);
    } finally {
      await app.dispose();
    }
  });
});

describe("createWfGraphApp configuration", () => {
  // Integration credentials are stored encrypted, so a missing or malformed key
  // has to stop startup rather than surface later as a failing integration read.
  it("refuses to start without an encryption key", async () => {
    await expect(
      createWfGraphApp({ ...BASE_OPTIONS, encryption: { key: undefined } })
    ).rejects.toThrow("encryption.key is unset");
  });

  // A host reading the key from an environment variable that is set to nothing
  // has the same problem as one that never set it, and gets the same message.
  it("treats a blank encryption key as unset", async () => {
    await expect(
      createWfGraphApp({ ...BASE_OPTIONS, encryption: { key: "  " } })
    ).rejects.toThrow("encryption.key is unset");
  });

  // The option belongs to the backend, beside the connection it applies to. A
  // directory that is not there is the cheapest proof that it was read at all:
  // startup migrations look for the folder before they open a connection.
  it("takes startup migrations from PostgreSQL persistence", async () => {
    await expect(
      createWfGraphApp({
        ...BASE_OPTIONS,
        persistence: wfPostgres({
          url: "postgresql://wfgraph:wfgraph@127.0.0.1:1/wfgraph_test",
          migrations: { runOnStartup: true, migrationsDir: "no-such-folder" },
        }),
      })
    ).rejects.toThrow("Migrations folder not found");
  });

  it("leaves the database alone when startup migrations go unasked for", async () => {
    const app = await createWfGraphApp({
      ...BASE_OPTIONS,
      persistence: wfPostgres({
        url: "postgresql://wfgraph:wfgraph@127.0.0.1:1/wfgraph_test",
        migrations: { migrationsDir: "no-such-folder" },
      }),
    });

    await app.dispose();
  });

  it("refuses an encryption key of the wrong length", async () => {
    await expect(
      createWfGraphApp({ ...BASE_OPTIONS, encryption: { key: "abc123" } })
    ).rejects.toThrow("64-character hex string");
  });

  // Dispose closes the app-owned pool: postgres.js holds an idle socket open per
  // pool, so a host that shuts Workflow Graph down and never exits would otherwise keep it.
  it("gives the database runtime back when an app is disposed", async () => {
    const app = await createTestApp();
    await app.dispose();

    const elsewhere = await createWfGraphApp({
      ...BASE_OPTIONS,
      persistence: wfPostgres({
        url: "postgresql://wfgraph:wfgraph@127.0.0.1:3/wfgraph_elsewhere",
      }),
    });
    await elsewhere.dispose();
  });

  // A host that catches a startup failure, corrects the option and calls again
  // gets a fresh app and database surface.
  it("gives the database config back when startup fails", async () => {
    await expect(
      createWfGraphApp({
        ...BASE_OPTIONS,
        client: { dir: join(tmpdir(), "wfgraph-no-such-bundle") },
      })
    ).rejects.toThrow("does not hold an index.html");

    const retried = await createWfGraphApp({
      ...BASE_OPTIONS,
      persistence: wfPostgres({
        url: "postgresql://wfgraph:wfgraph@127.0.0.1:2/wfgraph_other",
      }),
    });
    await retried.dispose();
  });

  // A host's own action reaches the editor through the catalog like any other, and
  // it does so from the definition the host passed rather than from anything
  // startup registered. Two apps in sequence is what says so: the surface is
  // assembled per app and given back on dispose, so the same definition serves the
  // second one as well.
  it("serves a host's own action from the definition it was handed", async () => {
    const action = defineAction({
      id: "host/probe",
      label: "Host Probe",
      description: "Passed to two apps, on purpose",
      input: Schema.Struct({ id: Schema.String }),
      output: Schema.Struct({
        id: Schema.String.annotate({ description: "What it echoed" }),
      }),
      handler: ({ input }) => ({ id: input.id }),
    });

    const first = await createWfGraphApp({
      ...BASE_OPTIONS,
      extensions: { actions: [action] },
    });
    await first.dispose();

    const second = await createWfGraphApp({
      ...BASE_OPTIONS,
      extensions: { actions: [action] },
    });
    try {
      const { catalog } = (await (
        await get(second, "/api/extensions")
      ).json()) as { catalog: { actions: Array<{ id: string }> } };

      expect(catalog.actions.map((entry) => entry.id)).toContain("host/probe");
    } finally {
      await second.dispose();
    }
  });
});

describe("createWfGraphApp with inngest.connect", () => {
  const close = vi.fn(async () => undefined);
  const connect = vi.fn();
  const realCreate = inngestClientModule.createInngestSurface;

  beforeEach(() => {
    connect.mockReset();
    close.mockReset();
    connect.mockResolvedValue({
      connectionId: "conn-app",
      state: "ACTIVE",
      close,
      closed: Promise.resolve(),
      getDebugState: vi.fn(),
    });
    vi.spyOn(inngestClientModule, "createInngestSurface").mockImplementation(
      (config) => realCreate(config, { connect })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens Connect at boot and drains it on dispose", async () => {
    const app = await createWfGraphApp({
      ...BASE_OPTIONS,
      inngest: { ...BASE_OPTIONS.inngest, connect: true },
    });
    try {
      expect(connect).toHaveBeenCalledTimes(1);
      expect(connect.mock.calls[0]?.[0]).toMatchObject({
        handleShutdownSignals: [],
      });
      // Connect dials out; the HTTP callback must not be advertised.
      expect((await get(app, "/api/inngest")).status).toBe(404);
    } finally {
      await app.dispose();
    }

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("leaves Connect alone when the host does not opt in", async () => {
    const app = await createTestApp();
    try {
      expect(connect).not.toHaveBeenCalled();
      expect((await get(app, "/api/inngest")).status).not.toBe(404);
    } finally {
      await app.dispose();
    }
  });

  it("logs a warning when Connect close fails during dispose", async () => {
    const warn = vi.fn();
    close.mockRejectedValueOnce(new Error("close failed"));
    const app = await createWfGraphApp({
      ...BASE_OPTIONS,
      inngest: { ...BASE_OPTIONS.inngest, connect: true },
      logger: { info: () => {}, warn, error: () => {} },
    });

    await app.dispose();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Connect worker close failed"),
      undefined
    );
  });

  // A handshake failure the SDK cannot itself retry (outside its
  // ReconnectError catch) still rejects `connect()` directly, and the shared
  // catch still gives the pool back so a host that retries after fixing
  // whatever broke is not refused by a leaked connection.
  it("rejects boot when Connect itself rejects and gives the pool back", async () => {
    const createSurface = dbModule.createDatabaseSurface;
    let database: ReturnType<typeof createSurface> | undefined;
    const surfaceSpy = vi
      .spyOn(dbModule, "createDatabaseSurface")
      .mockImplementation((config) => {
        database = createSurface(config);
        return database;
      });

    connect.mockRejectedValueOnce(new Error("gateway handshake failed"));

    try {
      await expect(
        createWfGraphApp({
          ...BASE_OPTIONS,
          inngest: { ...BASE_OPTIONS.inngest, connect: true },
        })
      ).rejects.toThrow("gateway handshake failed");

      if (!database) {
        throw new Error("Boot opened no database surface to give back.");
      }

      // A pool that was never ended would answer with ECONNREFUSED
      // (nothing listens on :1), not CONNECTION_ENDED.
      await expect(database.client`select 1`).rejects.toThrow(
        "CONNECTION_ENDED"
      );
    } finally {
      surfaceSpy.mockRestore();
    }
  });

  // Read against the inngest 4.x source this package accepts as its peer:
  // every handshake failure the SDK meets (a down gateway included) is a
  // ReconnectError, and
  // its reconcile loop retries a ReconnectError forever without ever
  // settling the promise connect() hands back. Boot must not hang behind
  // that: it fails once connectTimeoutMs elapses, names the gateway it could
  // not reach, and still gives the pool back.
  it("fails boot when Connect never settles, naming the gateway", async () => {
    const createSurface = dbModule.createDatabaseSurface;
    let database: ReturnType<typeof createSurface> | undefined;
    const surfaceSpy = vi
      .spyOn(dbModule, "createDatabaseSurface")
      .mockImplementation((config) => {
        database = createSurface(config);
        return database;
      });

    // Mirrors the SDK's own behavior against an unreachable gateway: the
    // handshake's ReconnectError is retried internally, so nothing outside
    // the SDK ever observes a rejection or a resolution.
    connect.mockReturnValueOnce(new Promise<never>(() => {}));

    try {
      await expect(
        createWfGraphApp({
          ...BASE_OPTIONS,
          inngest: {
            ...BASE_OPTIONS.inngest,
            connect: true,
            gatewayUrl: "ws://localhost:8390/v0/connect",
            connectTimeoutMs: 5,
          },
        })
      ).rejects.toThrow("ws://localhost:8390/v0/connect");

      if (!database) {
        throw new Error("Boot opened no database surface to give back.");
      }

      await expect(database.client`select 1`).rejects.toThrow(
        "CONNECTION_ENDED"
      );
    } finally {
      surfaceSpy.mockRestore();
    }
  });
});
