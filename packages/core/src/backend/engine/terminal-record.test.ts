import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Logger, References } from "effect";
import {
  createRecordingWorkflowStore,
  type RecordingWorkflowStore,
} from "#src/backend/engine/recording-store";
import type { WorkflowStore } from "#src/backend/engine/store";
import { recordVerdict } from "#src/backend/engine/terminal-record";
import { DatabaseError } from "#src/backend/lib/effect/database";

const terminalInput = {
  executionId: "exec_1",
  verdict: {
    kind: "verdict",
    status: "completed",
    reached: { kind: "walked", resultCount: 1 },
  },
  output: { ok: true },
} as const;

const exitContext = {
  entityType: "appointment",
  conditionId: "condition_1",
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

/**
 * A recording store whose first `completeRun` fails with `databaseError`, the
 * way a transient connection loss does, and whose later calls write through to
 * the recording store. Each call of the recorder models one attempt of the
 * durable step.
 */
function storeRefusingFirstCompletion(
  recording: RecordingWorkflowStore,
  databaseError: DatabaseError
): WorkflowStore {
  let attempts = 0;
  return {
    ...recording,
    completeRun: (input) => {
      attempts += 1;
      return attempts === 1
        ? Effect.fail(databaseError)
        : recording.completeRun(input);
    },
  };
}

const exitClaim = {
  kind: "exit",
  requestedAt: "2026-10-19T15:00:00.000Z",
  reason: "entity_condition_not_met",
  nodeId: "send-reminder",
} as const;

const cancelClaim = {
  kind: "cancel",
  requestedAt: "2026-10-19T15:00:00.000Z",
  eventName: "billing/subscription.canceled",
  payload: { reason: "customer left" },
} as const;

const fatalVerdict = (failureKind: string) =>
  ({
    kind: "verdict",
    status: "failed",
    reached: {
      kind: "fatal",
      error: "outcome read exhausted its retries",
      failureKind,
    },
  }) as const;

describe("recordVerdict", () => {
  it.effect(
    "fails so the step retries when the database refuses a run with no claim",
    () =>
      Effect.gen(function* () {
        const databaseError = new DatabaseError({
          cause: new Error("no connection"),
        });
        const recording = createRecordingWorkflowStore();
        recording.terminationState = {
          status: "running",
          claim: null,
          didWrite: false,
        };
        const store = storeRefusingFirstCompletion(recording, databaseError);
        const recordingLoggerLayer = recordingLogger();

        const failure = yield* Effect.flip(
          recordVerdict({ ...terminalInput, store }).pipe(
            Effect.provide(recordingLoggerLayer.layer)
          )
        );

        expect(failure).toBe(databaseError);
        expect(recordingLoggerLayer.lines).toEqual([
          {
            level: "Warn",
            message: "Terminal run record not written",
            properties: {
              run: { execution: "exec_1" },
              outcome: { verdict: "completed" },
              error: databaseError,
            },
          },
        ]);
        expect(recording.terminationState?.status).toBe("running");
        expect(recording.timeline).toHaveLength(0);

        const retried = yield* recordVerdict({ ...terminalInput, store });

        expect(retried).toEqual({ kind: "ended", status: "completed" });
        expect(recording.terminationState?.status).toBe("completed");
        expect(recording.timeline.map((call) => call.eventType)).toEqual([
          "run_completed",
        ]);
      })
  );

  it.effect(
    "fails so the step retries when the database refuses a run holding an Exit claim",
    () =>
      Effect.gen(function* () {
        const databaseError = new DatabaseError({
          cause: new Error("connection interrupted"),
        });
        const recording = createRecordingWorkflowStore();
        recording.terminationState = {
          status: "running",
          claim: exitClaim,
          didWrite: false,
        };
        const store = storeRefusingFirstCompletion(recording, databaseError);
        const exitInput = {
          ...terminalInput,
          verdict: { ...terminalInput.verdict, exitContext },
          store,
        };

        const failure = yield* Effect.flip(recordVerdict(exitInput));

        expect(failure).toBe(databaseError);
        expect(recording.terminationState).toMatchObject({
          status: "running",
          claim: exitClaim,
        });
        expect(recording.timeline).toHaveLength(0);

        const retried = yield* recordVerdict(exitInput);

        expect(retried).toEqual({ kind: "ended", status: "exited" });
        expect(recording.terminationState?.status).toBe("exited");
        expect(recording.timeline.map((call) => call.eventType)).toEqual([
          "run_exited",
        ]);
      })
  );

  it.effect(
    "returns a Cancel claim that refused the completed record, and writes nothing",
    () =>
      Effect.gen(function* () {
        const recording = createRecordingWorkflowStore();
        recording.terminationState = {
          status: "running",
          claim: cancelClaim,
          didWrite: false,
        };

        const result = yield* recordVerdict({
          ...terminalInput,
          store: recording,
        });

        expect(result).toEqual({
          kind: "cancel_claimed",
          cancel: {
            eventName: "billing/subscription.canceled",
            payload: { reason: "customer left" },
          },
        });
        expect(
          recording.callsOf("completeRun").map((call) => call.verdict.status)
        ).toEqual(["completed"]);
        expect(recording.terminationState?.status).toBe("running");
        expect(recording.timeline).toHaveLength(0);
      })
  );

  it.effect(
    "hands a refusing Cancel claim back unwritten whatever the failure kind",
    () =>
      Effect.gen(function* () {
        for (const kind of ["failure", "defect", "interrupt"] as const) {
          const recording = createRecordingWorkflowStore();
          recording.terminationState = {
            status: "running",
            claim: cancelClaim,
            didWrite: false,
          };

          const result = yield* recordVerdict({
            executionId: "exec_1",
            verdict: fatalVerdict(kind),
            store: recording,
          });

          expect(result).toEqual({
            kind: "cancel_claimed",
            cancel: {
              eventName: "billing/subscription.canceled",
              payload: { reason: "customer left" },
            },
          });
          expect(recording.terminationState?.status).toBe("running");
          expect(recording.timeline).toHaveLength(0);
        }
      })
  );

  it.effect("says another writer ended the run, and writes no entry", () =>
    Effect.gen(function* () {
      const recording = createRecordingWorkflowStore();
      const store: WorkflowStore = {
        ...recording,
        completeRun: () =>
          Effect.succeed({ kind: "already_ended", status: "exited" } as const),
      };
      const recordingLoggerLayer = recordingLogger();

      const result = yield* recordVerdict({ ...terminalInput, store }).pipe(
        Effect.provide(recordingLoggerLayer.layer)
      );

      expect(result).toEqual({ kind: "already_ended", status: "exited" });
      expect(recordingLoggerLayer.lines).toEqual([
        {
          level: "Info",
          message: "Run did not claim the terminal record",
          properties: {
            outcome: { verdict: "completed", left: "already_ended" },
          },
        },
      ]);
      expect(recording.timeline).toHaveLength(0);
    })
  );

  it.effect("redacts the output before it reaches the store", () =>
    Effect.gen(function* () {
      const recording = createRecordingWorkflowStore();

      yield* recordVerdict({
        ...terminalInput,
        output: { apiKey: "sk-live-123", ok: true },
        store: recording,
      });

      const [written] = recording.callsOf("completeRun");
      expect(written?.output).toMatchObject({ ok: true });
      expect(JSON.stringify(written?.output)).not.toContain("sk-live-123");
    })
  );
});
