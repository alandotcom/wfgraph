import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { createAction, defineEvent } from "#src/index";
import { defineIntegration } from "#src/backend/lib/extensions/define-integration";
import { defineStep } from "#src/backend/lib/steps/define-step";
import { createRovaApp, type RovaApp } from "#src/app";
import { createApiApp, MACHINE_ROUTES } from "#src/backend/api-app";
import { assembleExtensions } from "#src/backend/lib/extensions/extension-set";
import { createInngestSurface } from "#src/backend/lib/inngest/client";
import { createRovaRuntime } from "#src/backend/runtime";
import { normalizeDatabaseConfig } from "#src/backend/lib/db/config";
import { createDatabaseSurface } from "#src/backend/lib/db/index";
import { createIntegrationCipher } from "#src/backend/services/integrations/cipher";

// Every method a caller reaching this app could ask for, refused. The mock
// below fills in the one the function registry needs; the rest dying is what
// keeps a query nobody meant to run from reading a fake empty answer. Written
// out rather than taken from `test-layers`, because importing that module from
// inside the factory would have vitest resolving the module it is mocking.
const { emptyWorkflowRepo } = vi.hoisted(() => ({
  emptyWorkflowRepo: new Proxy({} as Record<string, unknown>, {
    get: (_target, method: string) => () => {
      throw new Error(`${method} is not part of this test`);
    },
  }),
}));

// The function registry reads the workflows table to decide which Inngest
// functions exist. Which functions it builds is beside the point here, so the
// query answers nothing and the connection is never opened; vitest scopes a
// mock to the file that declares it.
vi.mock("#src/backend/services/workflows/repo", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("#src/backend/services/workflows/repo")
    >();

  return {
    ...actual,
    WorkflowRepoLayer: Layer.succeed(actual.WorkflowRepo, {
      ...(emptyWorkflowRepo as typeof actual.WorkflowRepo.Service),
      listIdentities: () => Effect.succeed([]),
    }),
  };
});

// createRovaApp opens no connections: the database client is lazy and
// migrations only run when asked. Every route exercised below answers from
// process memory, so these tests need no Postgres and no Inngest.
const BASE_OPTIONS = {
  auth: "external",
  database: { url: "postgresql://rova:rova@127.0.0.1:1/rova_test" },
  encryption: { key: "a".repeat(64) },
  inngest: { id: "rova-app-test", isDev: true },
  // A logger that drops everything, so the suite gets no console sink.
  logger: { info: () => {}, warn: () => {}, error: () => {} },
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
    const app = await createRovaApp({
      ...BASE_OPTIONS,
      extensions: {
        integrations: [
          defineIntegration({
            type: "twilio",
            label: "Twilio",
            description: "Send SMS messages",
            credentials: [
              {
                label: "Auth Token",
                type: "password",
                configKey: "authToken",
                envVar: "TWILIO_AUTH_TOKEN",
              },
            ],
            actions: {
              "send-sms": defineStep({
                label: "Send SMS",
                description: "Sends a message",
                category: "Twilio",
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
              }),
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
    const inngest = createInngestSurface(BASE_OPTIONS.inngest);
    const database = createDatabaseSurface(
      normalizeDatabaseConfig(BASE_OPTIONS.database)
    );
    const runtime = createRovaRuntime({
      inngest,
      extensions: assembleExtensions({}),
      database,
      cipher: createIntegrationCipher(BASE_OPTIONS.encryption),
    });
    try {
      const app = createApiApp({
        basePath: "/rova/api",
        authorize: () => Promise.resolve(true),
        runtime,
        inngest,
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
      await database.close();
    }
  }

  /** Fill in Hono's `:param` and `*` segments so a request can be made. */
  function toRequestPath(path: string): string {
    return path.replace(/:[^/]+/g, "x").replace(/\*/g, "x");
  }

  it("refuses every non-machine path when the host says no", async () => {
    // Read first and on its own: the route table comes from a second app, and one
    // Rova per process means it cannot be open beside the guarded one.
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
        new Request("http://localhost/rova/api/workflows/waits/tok_1/resume", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(["wrong", "shape"]),
        })
      );
      // 400 from the route's own body validation, so the request got past the
      // gate rather than being turned away at it.
      expect(resume.status).toBe(400);

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

  // Dispose gives the process back, pools included: postgres.js holds an idle
  // socket open per pool, so a host that shuts Rova down and never exits would
  // otherwise keep them. A second app naming a different database is what says
  // the claim went with them, since a live one would refuse it.
  it("gives the database runtime back when an app is disposed", async () => {
    const app = await createTestApp();
    await app.dispose();

    const elsewhere = await createRovaApp({
      ...BASE_OPTIONS,
      database: { url: "postgresql://rova:rova@127.0.0.1:3/rova_elsewhere" },
    });
    await elsewhere.dispose();
  });

  // A host that catches a startup failure, corrects the option and calls again
  // gets a second app. Leaving the config recorded would have the retry refused
  // as a rebind, whatever it was corrected to.
  it("gives the database config back when startup fails", async () => {
    await expect(
      createRovaApp({
        ...BASE_OPTIONS,
        client: { dir: join(tmpdir(), "rova-no-such-bundle") },
      })
    ).rejects.toThrow("does not hold an index.html");

    const retried = await createRovaApp({
      ...BASE_OPTIONS,
      database: { url: "postgresql://rova:rova@127.0.0.1:2/rova_other" },
    });
    await retried.dispose();
  });

  // A host's own action reaches the editor through the catalog like any other, and
  // it does so from the definition the host passed rather than from anything
  // startup registered. Two apps in sequence is what says so: the surface is
  // assembled per app and given back on dispose, so the same definition serves the
  // second one as well.
  it("serves a host's own action from the definition it was handed", async () => {
    const action = createAction({
      id: "host/probe",
      label: "Host Probe",
      description: "Passed to two apps, on purpose",
      schema: Schema.Struct({ id: Schema.String }),
      outputSchema: Schema.Struct({
        id: Schema.String.annotate({ description: "What it echoed" }),
      }),
      execute: ({ payload }) => ({ success: true, data: { id: payload.id } }),
    });

    const first = await createRovaApp({
      ...BASE_OPTIONS,
      extensions: { actions: [action] },
    });
    await first.dispose();

    const second = await createRovaApp({
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
