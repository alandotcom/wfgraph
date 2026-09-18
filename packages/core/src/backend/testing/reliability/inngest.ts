import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { eventually } from "#src/backend/testing/reliability/control";

const PORT_BLOCK_START = 10_000;
const PORT_BLOCK_COUNT = 4_000;
const PORTS_PER_BLOCK = 4;
const portLeaseRoot = join(
  tmpdir(),
  `wfgraph-reliability-ports-${process.env.GITHUB_RUN_ID ?? process.ppid}`
);

type PortReservation = {
  ports: readonly [number, number, number, number];
  release: () => Promise<void>;
};

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function listenOnPort(port: number): Promise<Server> {
  const server = createServer();
  return new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => done(server));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((done, reject) =>
    server.close((error) => (error ? reject(error) : done()))
  );
}

export async function reserveInngestPorts(
  options: { firstBlock?: number } = {}
): Promise<PortReservation> {
  await mkdir(portLeaseRoot, { recursive: true });
  const firstBlock = options.firstBlock ?? randomInt(PORT_BLOCK_COUNT);
  for (let offset = 0; offset < PORT_BLOCK_COUNT; offset++) {
    const block = (firstBlock + offset) % PORT_BLOCK_COUNT;
    const leasePath = join(portLeaseRoot, String(block));
    try {
      // mkdir is the cross-process claim shared by Vitest's fork workers.
      // eslint-disable-next-line no-await-in-loop
      await mkdir(leasePath);
    } catch (error) {
      if (isErrnoException(error) && error.code === "EEXIST") continue;
      throw error;
    }
    const firstPort = PORT_BLOCK_START + block * PORTS_PER_BLOCK;
    const ports = [
      firstPort,
      firstPort + 1,
      firstPort + 2,
      firstPort + 3,
    ] as const;
    // The sockets prove that no unrelated process already owns this block. The
    // lease directory keeps sibling workers away after the sockets close.
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.allSettled(ports.map(listenOnPort));
    const servers = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : []
    );
    if (results.some((result) => result.status === "rejected")) {
      // Cleanup must finish before another block is attempted.
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(servers.map(closeServer));
      // eslint-disable-next-line no-await-in-loop
      await rm(leasePath, { recursive: true, force: true });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(servers.map(closeServer));
    let releasePromise: Promise<void> | undefined;
    return {
      ports,
      release: () =>
        (releasePromise ??= rm(leasePath, { recursive: true, force: true })),
    };
  }
  throw new Error("No four-port block is available for Inngest");
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
  // The CLI cannot inherit our listening sockets. A shared block lease keeps
  // sibling workers from taking these ports before the CLI binds them.
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
  const reservation = await reserveInngestPorts();
  const { ports } = reservation;
  const url = `http://127.0.0.1:${ports[0]}`;
  const spawnInngest = async () => {
    try {
      return spawn(
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
    } catch (error) {
      await reservation.release();
      throw error;
    }
  };
  const child = await spawnInngest();
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
      await reservation.release();
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
      return decodeRunState(body).data.functionRun;
    },
    async allRuns() {
      const body = await query(
        'query { runs(first: 100, orderBy: [{field: QUEUED_AT, direction: DESC}], filter: {from: "2020-01-01T00:00:00Z"}) { edges { node { id status } } } }'
      );
      return decodeAllRuns(body).data.runs.edges.map((edge) => edge.node);
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

const decodeRunState = Schema.decodeUnknownSync(
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
);

const decodeAllRuns = Schema.decodeUnknownSync(
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
);
