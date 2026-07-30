import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import middie from "@fastify/middie";
import express from "express";
import Fastify, { type FastifyInstance } from "fastify";
import { createRovaApp, type RovaApp } from "#src/app";
import { createRequestListener } from "#src/node";

// These are the tests the review that produced this plan asked for: a real
// Express app and a real Fastify app, each mounting Rova under a sub-path, so
// the two hazards the adapter exists to handle get exercised by the frameworks
// that actually cause them rather than by a hand-built IncomingMessage.
//
// Every route driven here answers out of process memory, so no Postgres and no
// Inngest are involved.

const MOUNT = "/rova";

let rova: RovaApp;
let expressServer: Server;
let expressOrigin: string;
let fastify: FastifyInstance;
let fastifyOrigin: string;
let parsedBodyServer: Server;
let parsedBodyOrigin: string;
let bareServer: Server;
let bareOrigin: string;
let mismatchedServer: Server;
let mismatchedOrigin: string;
let clientDir: string;

// A stand-in for @rova/client. What these cases assert is the routing and the
// injected base href, not the contents of the real bundle.
const STUB_CLIENT_ASSET = "stub-client.js";
const STUB_CLIENT_HTML = `<!doctype html><html><head><base href="/" /></head><body><script type="module" src="./${STUB_CLIENT_ASSET}"></script></body></html>`;

function originOf(server: Server): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

type TestResponse = { status: number; body: string };

/**
 * The test preload installs happy-dom, whose fetch applies a synthetic
 * document's same-origin policy and refuses these calls. node:http also matches
 * what the adapter under test is translating.
 */
function send(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      url,
      { method: options.method ?? "GET", headers: options.headers },
      (incoming) => {
        let body = "";
        incoming.setEncoding("utf-8");
        incoming.on("data", (chunk: string) => {
          body += chunk;
        });
        incoming.on("end", () => {
          resolve({ status: incoming.statusCode ?? 0, body });
        });
      }
    );

    outgoing.on("error", reject);
    if (options.body !== undefined) {
      outgoing.write(options.body);
    }
    outgoing.end();
  });
}

function postJson(url: string, body: string): Promise<TestResponse> {
  return send(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

beforeAll(async () => {
  clientDir = await mkdtemp(join(tmpdir(), "rova-node-client-"));
  await writeFile(join(clientDir, "index.html"), STUB_CLIENT_HTML);
  await writeFile(
    join(clientDir, STUB_CLIENT_ASSET),
    "export const stub = 1;\n"
  );

  rova = await createRovaApp({
    client: { dir: clientDir },
    auth: "external",
    basePath: MOUNT,
    // Deliberately a different identity from app.test.ts, so a reader can tell
    // the two apart in a log. vitest gives each test file its own module
    // registry, so the process-wide claim createRovaApp takes starts fresh here
    // whatever app.test.ts did with its own.
    database: { url: "postgresql://rova:rova@127.0.0.1:1/rova_test" },
    encryption: { key: "b".repeat(64) },
    inngest: { id: "rova-node-test", isDev: true },
    configureLogging: false,
  });

  const listener = createRequestListener(rova);

  const expressApp = express();
  expressApp.use(MOUNT, listener);
  expressServer = createServer(expressApp);
  await listen(expressServer);
  expressOrigin = originOf(expressServer);

  fastify = Fastify();
  await fastify.register(middie);
  // middie runs connect-style middleware in the onRequest hook, ahead of
  // Fastify's own body parsing, so the request stream reaches Rova intact.
  fastify.use(MOUNT, listener);
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  fastifyOrigin = originOf(fastify.server);

  // A deliberately misconfigured host: the body parser runs first and drains the
  // request, which is the mistake the adapter has to name rather than swallow.
  const parsedBodyApp = express();
  parsedBodyApp.use(express.json());
  parsedBodyApp.use(MOUNT, listener);
  parsedBodyServer = createServer(parsedBodyApp);
  await listen(parsedBodyServer);
  parsedBodyOrigin = originOf(parsedBodyServer);

  // A bare node:http server: nothing strips the path, so req.url is already
  // complete and originalUrl is never set. This is the branch neither framework
  // above reaches.
  bareServer = createServer(listener);
  await listen(bareServer);
  bareOrigin = originOf(bareServer);

  // A host that mounts Rova somewhere other than its configured basePath. Every
  // request 404s, and the adapter's job is to say why.
  const mismatchedApp = express();
  mismatchedApp.use("/elsewhere", listener);
  mismatchedServer = createServer(mismatchedApp);
  await listen(mismatchedServer);
  mismatchedOrigin = originOf(mismatchedServer);
});

afterAll(async () => {
  await fastify.close();
  await close(expressServer);
  await close(parsedBodyServer);
  await close(bareServer);
  await close(mismatchedServer);
  await rova.dispose();
  await rm(clientDir, { recursive: true, force: true });
});

describe.each([
  ["Express", () => expressOrigin],
  ["Fastify", () => fastifyOrigin],
])("Rova mounted under %s at /rova", (_name, origin) => {
  it("serves the API at the path the browser asked for", async () => {
    // Express rewrites req.url to "/api/extensions" here. Without the
    // originalUrl handling in the adapter, Rova would not recognize the path.
    const response = await send(`${origin()}/rova/api/extensions`);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      catalog: expect.any(Object),
    });
  });

  it("delivers a POST body to an oRPC procedure under the mounted prefix", async () => {
    const response = await postJson(
      `${origin()}/rova/api/rpc/workflow/getById`,
      JSON.stringify({ json: { workflowId: "" } })
    );

    // The body arrived and was parsed: the failure is the empty workflowId
    // failing the procedure's own schema, not a missing or unmatched request.
    expect(response.status).toBe(400);
    expect(response.body).toContain("Input validation failed");
  });

  it("delivers a POST body to the event intake route", async () => {
    // Valid JSON of the wrong shape, so validation rejects it before the route
    // reaches the database.
    const response = await postJson(
      `${origin()}/rova/api/events/order.created`,
      JSON.stringify(["not", "an", "object"])
    );

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({
      error: expect.any(String),
    });
  });

  it("reports a malformed body as such rather than as an empty one", async () => {
    const response = await postJson(
      `${origin()}/rova/api/events/order.created`,
      "{ not json"
    );

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({
      error: "Request body must be valid JSON",
    });
  });

  it("carries the query string across the mount", async () => {
    // openapi.json is the cheapest route that answers 200 and would notice a
    // path rebuilt from the wrong pieces.
    const response = await send(
      `${origin()}/rova/api/openapi.json?format=json`
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      servers: [{ url: "/rova/api/rest" }],
    });
  });

  it("serves the SPA and its assets under the mount", async () => {
    const index = await send(`${origin()}/rova/workflows`);

    expect(index.status).toBe(200);
    expect(index.body).toContain('<base href="/rova/" />');

    // The browser resolves the client's relative asset references against that
    // base href, so this is the URL it would actually request.
    const assetRef = index.body.match(/src="\.\/([^"]+\.js)"/)?.[1];
    expect(assetRef).toBeDefined();
    const asset = await send(`${origin()}/rova/${assetRef}`);
    expect(asset.status).toBe(200);
  });

  it("does not answer outside its mount", async () => {
    expect((await send(`${origin()}/api/extensions`)).status).toBe(404);
  });
});

describe("Rova mounted on a bare node:http server", () => {
  it("routes on req.url when no host stripped the path", async () => {
    const response = await send(`${bareOrigin}/rova/api/extensions`);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      catalog: expect.any(Object),
    });
  });
});

describe("Rova mounted somewhere other than its basePath", () => {
  it("404s, which is why the adapter logs the mismatch", async () => {
    expect(
      (await send(`${mismatchedOrigin}/elsewhere/api/extensions`)).status
    ).toBe(404);
  });
});

describe("Rova mounted behind a body parser", () => {
  it("names the misconfiguration instead of running on an empty body", async () => {
    const response = await postJson(
      `${parsedBodyOrigin}/rova/api/events/order.created`,
      JSON.stringify({ event: "created" })
    );

    expect(response.status).toBe(500);
    const body = JSON.parse(response.body) as { error: string };
    expect(body.error).toContain("already read");
    expect(body.error).toContain("body parser");
  });

  it("still serves requests that carry no body", async () => {
    expect((await send(`${parsedBodyOrigin}/rova/api/extensions`)).status).toBe(
      200
    );
  });
});
