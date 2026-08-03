import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Logger, References } from "effect";
import { createRecordingWorkflowStore } from "#src/backend/engine/recording-store";
import type { WorkflowStore } from "#src/backend/engine/store";
import { recordRunCompleted } from "#src/backend/engine/terminal-record";
import { DatabaseError } from "#src/backend/lib/effect/database";

const terminalInput = {
  executionId: "exec_1",
  workflowId: "workflow_1",
  status: "completed",
  output: { ok: true },
  resultCount: 1,
  runMode: "live",
} as const;

function recordingLogger() {
  const lines: {
    level: string;
    message: unknown;
    properties: Record<string, unknown>;
  }[] = [];
  const logger = Logger.make<unknown, void>(({ fiber, logLevel, message }) => {
    lines.push({
      level: logLevel,
      message: Array.isArray(message) ? message[0] : message,
      properties: fiber.getRef(References.CurrentLogAnnotations),
    });
  });
  return {
    lines,
    layer: Layer.merge(
      Logger.layer([logger]),
      Layer.succeed(References.MinimumLogLevel, "All")
    ),
  };
}

describe("terminal record completion policy", () => {
  it.effect("warns and skips the audit when the database refuses", () =>
    Effect.gen(function* () {
      const databaseError = new DatabaseError({
        cause: new Error("no connection"),
      });
      const recording = createRecordingWorkflowStore();
      const store: WorkflowStore = {
        ...recording,
        completeRun: () => Effect.fail(databaseError),
      };
      const recordingLoggerLayer = recordingLogger();

      yield* recordRunCompleted({ ...terminalInput, store }).pipe(
        Effect.provide(recordingLoggerLayer.layer)
      );

      expect(recordingLoggerLayer.lines).toEqual([
        {
          level: "Warn",
          message: "Terminal run record not written",
          properties: {
            executionId: "exec_1",
            status: "completed",
            error: databaseError,
          },
        },
      ]);
      expect(recording.callsOf("recordAuditEvent")).toHaveLength(0);
    })
  );

  it.effect("logs info and skips the audit when another status won", () =>
    Effect.gen(function* () {
      const recording = createRecordingWorkflowStore();
      const store: WorkflowStore = {
        ...recording,
        completeRun: () => Effect.succeed(false),
      };
      const recordingLoggerLayer = recordingLogger();

      yield* recordRunCompleted({ ...terminalInput, store }).pipe(
        Effect.provide(recordingLoggerLayer.layer)
      );

      expect(recordingLoggerLayer.lines).toEqual([
        {
          level: "Info",
          message: "Run did not claim the terminal record",
          properties: { status: "completed" },
        },
      ]);
      expect(recording.callsOf("recordAuditEvent")).toHaveLength(0);
    })
  );
});
