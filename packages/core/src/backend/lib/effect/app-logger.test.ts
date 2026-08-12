import { afterAll, describe, expect, test } from "vitest";
import { Effect } from "effect";
import { AppLogger, AppLoggerLayer } from "#src/backend/lib/effect/app-logger";
import { resetSync } from "@logtape/logtape";
import { configureLoggingWithBridge } from "#src/backend/lib/log-config";

describe("AppLoggerLayer", () => {
  test("sends inherited Effect annotations to the host logtape sink", async () => {
    const lines: {
      level: string;
      message: string;
      properties?: unknown;
    }[] = [];
    // The bridge takes the level the environment names, which is info. This
    // case is about a debug record reaching the sink with its annotations.
    configureLoggingWithBridge(
      {
        debug: (message, properties) => {
          lines.push({ level: "debug", message: String(message), properties });
        },
        info: (message, properties) => {
          lines.push({ level: "info", message: String(message), properties });
        },
        warn: (message, properties) => {
          lines.push({ level: "warn", message: String(message), properties });
        },
        error: (message, properties) => {
          lines.push({ level: "error", message: String(message), properties });
        },
      },
      "debug"
    );

    const program = Effect.gen(function* () {
      const logger = (yield* AppLogger)
        .get("engine")
        .with({ lineField: "kept-structured" });
      yield* logger.debug("Executing action node");
    }).pipe(
      Effect.annotateLogs({ workflowId: "workflow_1" }),
      Effect.annotateLogs({ nodeId: "node_1", nodeName: "Send email" }),
      Effect.annotateLogs({ actionType: "resend/send-email" }),
      Effect.provide(AppLoggerLayer)
    );

    await Effect.runPromise(program);

    expect(lines).toEqual([
      {
        level: "debug",
        message: "[wfgraph.engine] Executing action node",
        properties: {
          workflowId: "workflow_1",
          nodeId: "node_1",
          nodeName: "Send email",
          actionType: "resend/send-email",
          lineField: "kept-structured",
        },
      },
    ]);
  });
});

// Back to unconfigured, which is logtape's own default and what every other
// file in this worker expects: the suite shares one module graph.
afterAll(() => {
  resetSync();
});
