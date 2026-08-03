import { afterAll, describe, expect, test } from "vitest";
import { Effect } from "effect";
import { AppLogger, AppLoggerLayer } from "#src/backend/lib/effect/app-logger";
import {
  configureAppLogging,
  configureAppLoggingWithBridge,
} from "#src/backend/lib/logger";

describe("AppLoggerLayer", () => {
  test("sends inherited Effect annotations to the host logtape sink", async () => {
    const lines: {
      level: string;
      message: string;
      properties?: unknown;
    }[] = [];
    configureAppLoggingWithBridge({
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
    });

    const program = Effect.gen(function* () {
      const logger = (yield* AppLogger)
        .get("workflow", "executor")
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
        message: "[app.workflow.executor] Executing action node",
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

afterAll(() => {
  configureAppLogging();
});
