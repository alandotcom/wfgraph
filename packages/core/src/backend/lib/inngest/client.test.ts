import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { connect as connectInngestSdk } from "inngest/connect";
import { createInngestSurface } from "#src/backend/lib/inngest/client";
import { resetSync } from "@logtape/logtape";
import { configureLoggingWithBridge } from "#src/backend/lib/log-config";

/** The startup lines, read off logtape through the bridge sink. */
const logLines: string[] = [];

/** Mode/warn cases do not dial Connect; they still owe the required dep. */
const surfaceDeps = { connect: connectInngestSdk };

beforeEach(() => {
  logLines.length = 0;
  configureLoggingWithBridge({
    info: () => undefined,
    warn: (message) => {
      logLines.push(String(message));
    },
    error: (message) => {
      logLines.push(String(message));
    },
  });

  // Whatever the machine running the suite has set, each case states its own
  // environment: every one of these participates in the mode the SDK resolves.
  vi.stubEnv("NODE_ENV", undefined);
  vi.stubEnv("INNGEST_DEV", undefined);
  vi.stubEnv("INNGEST_SIGNING_KEY", undefined);
  vi.stubEnv("INNGEST_BASE_URL", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// Back to unconfigured, which is logtape's own default and what every other
// file in this worker expects: the suite shares one module graph.
afterAll(() => {
  resetSync();
});

/**
 * Cloud mode is the whole of the signature check: the SDK returns success from
 * `validateSignature` with no verification whenever the client is in dev mode,
 * and `/api/inngest` sits outside the host's auth gate.
 */
describe("createInngestSurface mode", () => {
  it("runs in cloud mode when the host says nothing", () => {
    const surface = createInngestSurface({ id: "mode-unset" }, surfaceDeps);

    expect(surface.client.mode).toBe("cloud");
  });

  it("keeps cloud mode when NODE_ENV names something other than production", () => {
    vi.stubEnv("NODE_ENV", "staging");

    expect(
      createInngestSurface({ id: "mode-staging" }, surfaceDeps).client.mode
    ).toBe("cloud");
  });

  it("runs in dev mode only where the host opts in", () => {
    expect(
      createInngestSurface({ id: "mode-dev", isDev: true }, surfaceDeps).client
        .mode
    ).toBe("dev");
  });

  // The option is passed through undefined rather than defaulted, which is what
  // leaves the SDK's own environment fallback reachable.
  it("honours INNGEST_DEV", () => {
    vi.stubEnv("INNGEST_DEV", "1");

    expect(
      createInngestSurface({ id: "mode-env-dev" }, surfaceDeps).client.mode
    ).toBe("dev");
  });
});

describe("the callback exposure warning", () => {
  it("names dev mode as the cause, signing key or not", () => {
    vi.stubEnv("INNGEST_SIGNING_KEY", "signkey-test-abc");
    createInngestSurface({ id: "warn-dev", isDev: true }, surfaceDeps);

    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain("dev mode");
  });

  it("names the missing signing key in cloud mode", () => {
    createInngestSurface({ id: "warn-unsigned" }, surfaceDeps);

    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain("no signing key");
  });

  it("stays quiet for a signed cloud deployment", () => {
    createInngestSurface(
      { id: "warn-none", signingKey: "signkey-test-abc" },
      surfaceDeps
    );

    expect(logLines).toEqual([]);
  });

  it("skips the HTTP callback warning when Connect is opted in", () => {
    vi.stubEnv("INNGEST_SIGNING_KEY", "signkey-test-abc");
    createInngestSurface(
      {
        id: "warn-connect-dev",
        isDev: true,
        connect: true,
      },
      surfaceDeps
    );

    expect(logLines).toEqual([]);
  });

  it("names the missing signing key for Connect in cloud mode", () => {
    createInngestSurface(
      { id: "warn-connect-unsigned", connect: true },
      surfaceDeps
    );

    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain("Connect has no signing key");
  });
});

describe("createInngestSurface connect", () => {
  const functions = [{ id: "workflow-run" }] as never[];
  const connect = vi.fn();

  beforeEach(() => {
    connect.mockReset();
    connect.mockResolvedValue({
      connectionId: "conn-test",
      state: "ACTIVE",
      close: vi.fn(),
      closed: Promise.resolve(),
      getDebugState: vi.fn(),
    });
  });

  it("registers the caller's function list on a Connect WebSocket", async () => {
    const surface = createInngestSurface(
      {
        id: "connect-app",
        isDev: true,
        instanceId: "worker-1",
        gatewayUrl: "ws://localhost:8390/v0/connect",
        maxWorkerConcurrency: 4,
      },
      { connect }
    );

    const connection = await surface.connect(functions);

    expect(connect).toHaveBeenCalledWith({
      apps: [{ client: surface.client, functions }],
      instanceId: "worker-1",
      gatewayUrl: "ws://localhost:8390/v0/connect",
      maxWorkerConcurrency: 4,
      handleShutdownSignals: [],
    });
    expect(connection.connectionId).toBe("conn-test");
  });

  // The SDK's own reconcile loop keeps retrying a handshake after the
  // timeout has rejected boot: nothing cancels it, so it can still land a
  // WorkerConnection later. Left alone, that connection sits registered
  // with the gateway (WORKER_READY already sent) with nothing holding it,
  // because createWfGraphApp tore its runtime and pool down when boot's promise
  // rejected. The late arrival must be closed, not silently dropped.
  it("closes a handshake that resolves after boot's timeout already rejected", async () => {
    let resolveConnect!: (value: {
      connectionId: string;
      state: string;
      close: () => Promise<void>;
      closed: Promise<void>;
      getDebugState: () => unknown;
    }) => void;
    connect.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveConnect = resolve;
      })
    );

    const surface = createInngestSurface(
      {
        id: "connect-late",
        isDev: true,
        connectTimeoutMs: 5,
      },
      { connect }
    );

    await expect(surface.connect(functions)).rejects.toThrow("could not reach");

    const close = vi.fn().mockResolvedValue(undefined);
    resolveConnect({
      connectionId: "conn-late",
      state: "ACTIVE",
      close,
      closed: Promise.resolve(),
      getDebugState: vi.fn(),
    });

    // Give the late `.then()` handler a turn to run.
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(close).toHaveBeenCalledTimes(1);
  });
});
