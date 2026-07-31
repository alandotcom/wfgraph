import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createInngestSurface } from "#src/backend/lib/inngest/client";
import { stubRovaRuntime } from "#src/backend/lib/effect/test-layers";
import {
  configureAppLogging,
  configureAppLoggingWithBridge,
} from "#src/backend/lib/logger";

const buildInngestFunctions = vi.hoisted(() => vi.fn());

vi.mock("#src/backend/lib/inngest/functions", () => ({
  buildInngestFunctions,
}));

/** The startup lines, read off logtape through the bridge sink. */
const logLines: string[] = [];

beforeEach(() => {
  logLines.length = 0;
  configureAppLoggingWithBridge({
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
});

afterAll(() => {
  configureAppLogging();
});

/**
 * Cloud mode is the whole of the signature check: the SDK returns success from
 * `validateSignature` with no verification whenever the client is in dev mode,
 * and `/api/inngest` sits outside the host's auth gate.
 */
describe("createInngestSurface mode", () => {
  it("runs in cloud mode when the host says nothing", () => {
    const surface = createInngestSurface({ id: "mode-unset" });

    expect(surface.client.mode).toBe("cloud");
  });

  it("keeps cloud mode when NODE_ENV names something other than production", () => {
    vi.stubEnv("NODE_ENV", "staging");

    expect(createInngestSurface({ id: "mode-staging" }).client.mode).toBe(
      "cloud"
    );
  });

  it("runs in dev mode only where the host opts in", () => {
    expect(
      createInngestSurface({ id: "mode-dev", isDev: true }).client.mode
    ).toBe("dev");
  });

  // The option is passed through undefined rather than defaulted, which is what
  // leaves the SDK's own environment fallback reachable.
  it("honours INNGEST_DEV", () => {
    vi.stubEnv("INNGEST_DEV", "1");

    expect(createInngestSurface({ id: "mode-env-dev" }).client.mode).toBe(
      "dev"
    );
  });
});

describe("the callback exposure warning", () => {
  it("names dev mode as the cause, signing key or not", () => {
    vi.stubEnv("INNGEST_SIGNING_KEY", "signkey-test-abc");
    createInngestSurface({ id: "warn-dev", isDev: true });

    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain("dev mode");
  });

  it("names the missing signing key in cloud mode", () => {
    createInngestSurface({ id: "warn-unsigned" });

    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain("no signing key");
  });

  it("stays quiet for a signed cloud deployment", () => {
    createInngestSurface({ id: "warn-none", signingKey: "signkey-test-abc" });

    expect(logLines).toEqual([]);
  });
});

/**
 * `serve` builds the handler fresh on every call rather than caching one: the
 * only caller is `assembleRovaApp`, which awaits it once at boot, so a broken
 * build fails there instead of leaking a stuck retry state into the request path.
 */
describe("createInngestSurface serve", () => {
  beforeEach(() => {
    buildInngestFunctions.mockReset();
  });

  it("rejects on every call rather than caching a failed build", async () => {
    buildInngestFunctions.mockRejectedValue(new Error("boom"));
    const surface = createInngestSurface({ id: "serve-fails", isDev: true });
    const runtime = stubRovaRuntime();

    await expect(surface.serve(runtime)).rejects.toThrow("boom");
    await expect(surface.serve(runtime)).rejects.toThrow("boom");

    expect(buildInngestFunctions).toHaveBeenCalledTimes(2);
  });
});
