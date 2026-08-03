import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";
import { createRecordingWorkflowStore } from "#src/backend/engine/recording-store";
import type { WorkflowStore } from "#src/backend/engine/store";
import { recordRunCompleted } from "#src/backend/engine/terminal-record";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { getAppLogger } from "#src/backend/lib/logger";

const terminalInput = {
  executionId: "exec_1",
  workflowId: "workflow_1",
  status: "completed",
  output: { ok: true },
  resultCount: 1,
  runMode: "live",
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

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
      const logger = getAppLogger("test", "terminal-record").with({
        executionId: terminalInput.executionId,
      });
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const info = vi.spyOn(logger, "info").mockImplementation(() => {});

      yield* recordRunCompleted({ ...terminalInput, store, logger });

      expect(warn).toHaveBeenCalledWith("Terminal run record not written", {
        executionId: "exec_1",
        status: "completed",
        error: databaseError,
      });
      expect(info).not.toHaveBeenCalled();
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
      const logger = getAppLogger("test", "terminal-record").with({
        executionId: terminalInput.executionId,
      });
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const info = vi.spyOn(logger, "info").mockImplementation(() => {});

      yield* recordRunCompleted({ ...terminalInput, store, logger });

      expect(info).toHaveBeenCalledWith(
        "Run did not claim the terminal record",
        { status: "completed" }
      );
      expect(warn).not.toHaveBeenCalled();
      expect(recording.callsOf("recordAuditEvent")).toHaveLength(0);
    })
  );
});
