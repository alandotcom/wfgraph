import { afterAll, describe, expect, it } from "vitest";
import { resetSync } from "@logtape/logtape";
import { configureLoggingWithBridge } from "#src/backend/lib/log-config";
import { createInngestSdkLogger } from "#src/backend/lib/inngest/sdk-logger";

type RecordedLine = { message: string; properties?: unknown };

function recordLogLines(): RecordedLine[] {
  const lines: RecordedLine[] = [];
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
  return lines;
}

describe("createInngestSdkLogger", () => {
  it("merges a nested plain object into properties and keeps an Error under a numbered key", () => {
    const lines = recordLogLines();

    const sdkLogger = createInngestSdkLogger();
    sdkLogger.info("Handshake failed", new Error("boom"), { attempt: 2 });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.message).toBe("[wfgraph.inngest] Handshake failed");
    const properties = lines[0]?.properties as Record<string, unknown>;
    expect(properties.attempt).toBe(2);
    expect(properties.arg0).toBeInstanceOf(Error);
    expect((properties.arg0 as Error).message).toBe("boom");
  });

  it("uses a placeholder message when the SDK sends no string", () => {
    const lines = recordLogLines();

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

// The suite shares one module graph, so this puts logtape back to the
// unconfigured default the files running after this one expect.
afterAll(() => {
  resetSync();
});
