import { afterAll, describe, expect, test } from "vitest";
import { resetSync } from "@logtape/logtape";
import { configureLoggingWithBridge } from "#src/backend/lib/log-config";
import { createInngestSdkLogger } from "#src/backend/lib/inngest/sdk-logger";

describe("createInngestSdkLogger", () => {
  test("merges a nested plain object into properties and keeps an Error under a numbered key", () => {
    const lines: { message: string; properties?: unknown }[] = [];
    configureLoggingWithBridge(
      {
        debug: (message, properties) => {
          lines.push({ message: String(message), properties });
        },
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      "debug"
    );

    const sdkLogger = createInngestSdkLogger();
    sdkLogger.info("Handshake failed", new Error("boom"), { attempt: 2 });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.message).toBe("[wfgraph.inngest] Handshake failed");
    const properties = lines[0]?.properties as Record<string, unknown>;
    expect(properties.attempt).toBe(2);
    expect(properties.arg0).toBeInstanceOf(Error);
    expect((properties.arg0 as Error).message).toBe("boom");
  });

  test("uses a placeholder message when the SDK sends no string", () => {
    const lines: { message: string; properties?: unknown }[] = [];
    configureLoggingWithBridge(
      {
        debug: (message, properties) => {
          lines.push({ message: String(message), properties });
        },
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      "debug"
    );

    const sdkLogger = createInngestSdkLogger();
    sdkLogger.debug({ connectionId: "conn_1" });

    expect(lines).toEqual([
      {
        message: "[wfgraph.inngest] Inngest SDK message",
        properties: { connectionId: "conn_1" },
      },
    ]);
  });
});

// Back to unconfigured, which is logtape's own default and what every other
// file in this worker expects: the suite shares one module graph.
afterAll(() => {
  resetSync();
});
