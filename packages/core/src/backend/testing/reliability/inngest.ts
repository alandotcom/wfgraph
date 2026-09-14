import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { Schema } from "effect";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { eventually } from "#src/backend/testing/reliability/control";

async function freePorts() {
  const servers = await Promise.all(
    Array.from({ length: 4 }, async () => {
      const server = createServer();
      await new Promise<void>((done, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", done);
      });
      return server;
    })
  );
  const ports = servers.map((server) => {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing reserved port");
    return address.port;
  });
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((done, reject) =>
          server.close((error) => (error ? reject(error) : done()))
        )
    )
  );
  return ports;
}
type InngestRunner = {
  url: string;
  logs: string[];
  close: () => Promise<void>;
  runState: (runId: string) => Promise<{
    readonly id: string;
    readonly status: string | null;
    readonly history: ReadonlyArray<{
      readonly type: string;
      readonly stepName: string | null;
    }>;
  } | null>;
  allRuns: () => Promise<
    Array<{ readonly id: string; readonly status: string }>
  >;
  register: (sdkUrl: string) => Promise<void>;
  send: (name: string, data: JsonObject, id?: string) => Promise<void>;
};
export class InngestStartupFailure extends Error {
  constructor(
    cause: unknown,
    readonly logs: string[]
  ) {
    super(`Inngest startup failed: ${String(cause)}`, { cause });
  }
}

type StartupOptions = {
  binary?: string | undefined;
  timeoutMs?: number | undefined;
};

export async function startInngest(
  directory: string,
  options: StartupOptions = {}
): Promise<InngestRunner> {
  const previousLogs: string[] = [];
  // The CLI cannot inherit our listening sockets. Another worker or an outgoing
  // connection can take a port between releasing it and the CLI binding it.
  for (let attempt = 1; ; attempt++) {
    const logs: string[] = [`Inngest startup attempt ${attempt}\n`];
    try {
      // Each failed process must stop before another can use its data directory.
      // eslint-disable-next-line no-await-in-loop
      const runner = await startInngestAttempt(directory, logs, options);
      runner.logs.unshift(...previousLogs);
      return runner;
    } catch (error) {
      previousLogs.push(...logs);
      if (
        attempt >= 3 ||
        !(error instanceof Error) ||
        !error.message.includes("bind: address already in use")
      ) {
        throw new InngestStartupFailure(error, previousLogs);
      }
    }
  }
}

async function startInngestAttempt(
  directory: string,
  logs: string[],
  options: StartupOptions
): Promise<InngestRunner> {
  const ports = await freePorts();
  const url = `http://127.0.0.1:${ports[0]}`;
  const child = spawn(
    options.binary ?? resolve("node_modules/.bin/inngest"),
    [
      "dev",
      "--no-discovery",
      "--no-poll",
      "--persist",
      "--retry-interval",
      "1",
      "--port",
      String(ports[0]),
      "--connect-gateway-port",
      String(ports[1]),
      "--connect-gateway-grpc-port",
      String(ports[2]),
      "--connect-executor-grpc-port",
      String(ports[3]),
    ],
    {
      cwd: directory,
      env: { ...process.env, DO_NOT_TRACK: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  child.stdout.on("data", (value) => logs.push(String(value)));
  child.stderr.on("data", (value) => logs.push(String(value)));
  let spawnError: Error | undefined;
  child.on("error", (error) => {
    spawnError = error;
  });
  const closed = new Promise<void>((done) => {
    // close follows exit/error and drains the process's final diagnostics.
    child.once("close", () => done());
  });
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      await closed;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await eventually(
      "Inngest health",
      async () => {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null) throw new Error(logs.join(""));
        try {
          return (
            await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })
          ).ok;
        } catch {
          return false;
        }
      },
      Boolean,
      options.timeoutMs
    );
  } catch (error) {
    await close();
    throw error;
  }
  const query = async (document: string, variables: JsonObject = {}) => {
    const response = await fetch(`${url}/v0/gql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: document, variables }),
      signal: AbortSignal.timeout(5000),
    });
    const body: unknown = await response.json();
    return body;
  };
  return {
    url,
    logs,
    close,
    async runState(runId: string) {
      const body = await query(
        "query($id: ID!) { functionRun(query: {functionRunId: $id}) { id status history { type stepName } } }",
        { id: runId }
      );
      return Schema.decodeUnknownSync(
        Schema.Struct({
          data: Schema.Struct({
            functionRun: Schema.NullOr(
              Schema.Struct({
                id: Schema.String,
                status: Schema.NullOr(Schema.String),
                history: Schema.Array(
                  Schema.Struct({
                    type: Schema.String,
                    stepName: Schema.NullOr(Schema.String),
                  })
                ),
              })
            ),
          }),
        })
      )(body).data.functionRun;
    },
    async allRuns() {
      const body = await query(
        'query { runs(first: 100, orderBy: [{field: QUEUED_AT, direction: DESC}], filter: {from: "2020-01-01T00:00:00Z"}) { edges { node { id status } } } }'
      );
      return Schema.decodeUnknownSync(
        Schema.Struct({
          data: Schema.Struct({
            runs: Schema.Struct({
              edges: Schema.Array(
                Schema.Struct({
                  node: Schema.Struct({
                    id: Schema.String,
                    status: Schema.String,
                  }),
                })
              ),
            }),
          }),
        })
      )(body).data.runs.edges.map((edge) => edge.node);
    },
    async register(sdkUrl: string) {
      const response = await fetch(`${url}/v0/gql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query:
            "mutation($url: String!) { createApp(input: {url: $url}) { id } }",
          variables: { url: sdkUrl },
        }),
      });
      const body: unknown = await response.json();
      Schema.decodeUnknownSync(
        Schema.Struct({
          data: Schema.Struct({
            createApp: Schema.Struct({ id: Schema.String }),
          }),
        })
      )(body);
    },
    async send(name: string, data: JsonObject, id = crypto.randomUUID()) {
      const response = await fetch(`${url}/e/dev_key`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, name, data }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        throw new Error(
          `Event delivery failed: ${response.status} ${await response.text()}`
        );
    },
  };
}
