import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Logger, References } from "effect";
import {
  createRecordingWorkflowStore,
  type RecordingWorkflowStore,
} from "#src/backend/engine/recording-store";
import type { WorkflowStore } from "#src/backend/engine/store";
import {
  recordRunCompleted,
  recordRunFailed,
} from "#src/backend/engine/terminal-record";
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

const fatalInput = {
  executionId: "exec_1",
  workflowId: "workflow_1",
  failure: { kind: "failure", message: "outcome read exhausted its retries" },
  runMode: "live",
} as const;

describe("terminal record completion policy", () => {
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
          recordRunCompleted({ ...terminalInput, store }).pipe(
            Effect.provide(recordingLoggerLayer.layer)
          )
        );

        expect(failure).toBe(databaseError);
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
        expect(recording.terminationState?.status).toBe("running");
        expect(recording.callsOf("recordAuditEvent")).toHaveLength(0);

        const retried = yield* recordRunCompleted({ ...terminalInput, store });

        expect(retried).toEqual({ status: "completed" });
        expect(recording.terminationState?.status).toBe("completed");
        expect(
          recording.callsOf("recordAuditEvent").map((call) => call.eventType)
        ).toEqual(["run_completed"]);
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
          status: "exited",
          store,
          exitContext: {
            entityType: "appointment",
            conditionId: "condition_1",
          },
        } as const;

        const failure = yield* Effect.flip(recordRunCompleted(exitInput));

        expect(failure).toBe(databaseError);
        expect(recording.terminationState).toMatchObject({
          status: "running",
          claim: exitClaim,
        });
        expect(recording.callsOf("recordAuditEvent")).toHaveLength(0);

        const retried = yield* recordRunCompleted(exitInput);

        expect(retried).toEqual({
          status: "exited",
          exit: {
            reason: "entity_condition_not_met",
            entityType: "appointment",
            conditionId: "condition_1",
            nodeId: "send-reminder",
            checkedAt: "2026-10-19T15:00:00.000Z",
          },
        });
        expect(recording.terminationState?.status).toBe("exited");
        expect(
          recording.callsOf("recordAuditEvent").map((call) => call.eventType)
        ).toEqual(["run_exited"]);
      })
  );

  it.effect(
    "fails the failed-run record so the step retries when the database refuses",
    () =>
      Effect.gen(function* () {
        const databaseError = new DatabaseError({
          cause: new Error("no connection"),
        });
        const recording = createRecordingWorkflowStore();
        const store = storeRefusingFirstCompletion(recording, databaseError);
        const failedInput = {
          store,
          executionId: "exec_1",
          workflowId: "workflow_1",
          outcome: { kind: "failed" },
          failure: { kind: "failure", message: "node exploded" },
          runMode: "live",
        } as const;

        const failure = yield* Effect.flip(recordRunFailed(failedInput));

        expect(failure).toBe(databaseError);
        expect(recording.callsOf("recordAuditEvent")).toHaveLength(0);

        const retried = yield* recordRunFailed(failedInput);

        expect(retried).toEqual({ status: "failed" });
        expect(recording.terminationState?.status).toBe("failed");
        expect(
          recording.callsOf("recordAuditEvent").map((call) => call.eventType)
        ).toEqual(["run_failed"]);
      })
  );

  it.effect("finalizes and announces an Exit claim that raced completion", () =>
    Effect.gen(function* () {
      const recording = createRecordingWorkflowStore();
      let call = 0;
      const terminalWrites: Parameters<WorkflowStore["completeRun"]>[0][] = [];
      const store: WorkflowStore = {
        ...recording,
        completeRun: (input) =>
          Effect.sync(() => {
            terminalWrites.push(input);
            call += 1;
            return call === 1
              ? {
                  status: "running" as const,
                  claim: {
                    kind: "exit" as const,
                    requestedAt: "2026-10-19T15:00:00.000Z",
                    reason: "entity_condition_not_met" as const,
                    nodeId: "send-reminder",
                  },
                  didWrite: false,
                }
              : {
                  status: "exited" as const,
                  claim: {
                    kind: "exit" as const,
                    requestedAt: "2026-10-19T15:00:00.000Z",
                    reason: "entity_condition_not_met" as const,
                    nodeId: "send-reminder",
                  },
                  didWrite: true,
                };
          }),
      };

      const result = yield* recordRunCompleted({
        ...terminalInput,
        store,
        failure: { kind: "failure", message: "losing traversal failure" },
        exitContext: {
          entityType: "appointment",
          conditionId: "condition_1",
        },
      });

      expect(result).toMatchObject({ status: "exited" });
      expect(call).toBe(2);
      expect(terminalWrites[1]).toEqual({
        executionId: "exec_1",
        status: "exited",
        output: { ok: true },
        failure: undefined,
      });
      expect(recording.callsOf("recordAuditEvent")).toEqual([
        expect.objectContaining({
          eventType: "run_exited",
          metadata: expect.objectContaining({
            entityType: "appointment",
            nodeId: "send-reminder",
          }),
        }),
      ]);
    })
  );

  it.effect("fails so a claimed Exit finalization can be retried", () =>
    Effect.gen(function* () {
      const databaseError = new DatabaseError({
        cause: new Error("connection interrupted"),
      });
      const recording = createRecordingWorkflowStore();
      let call = 0;
      const store: WorkflowStore = {
        ...recording,
        completeRun: () => {
          call += 1;
          return call === 1
            ? Effect.succeed({
                status: "running" as const,
                claim: {
                  kind: "exit" as const,
                  requestedAt: "2026-10-19T15:00:00.000Z",
                  reason: "entity_condition_not_met" as const,
                  nodeId: "send-reminder",
                },
                didWrite: false,
              })
            : Effect.fail(databaseError);
        },
      };
      const recordingLoggerLayer = recordingLogger();

      const failure = yield* Effect.flip(
        recordRunCompleted({ ...terminalInput, store }).pipe(
          Effect.provide(recordingLoggerLayer.layer)
        )
      );

      expect(failure).toBe(databaseError);
      expect(call).toBe(2);
      expect(recording.callsOf("recordAuditEvent")).toHaveLength(0);
      expect(recordingLoggerLayer.lines).toEqual([
        {
          level: "Warn",
          message: "Claimed terminal run record not written",
          properties: {
            executionId: "exec_1",
            status: "exited",
            error: databaseError,
          },
        },
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

        const result = yield* recordRunCompleted({
          ...terminalInput,
          store: recording,
        });

        expect(result).toEqual({
          status: "running",
          cancelClaim: {
            eventName: "billing/subscription.canceled",
            payload: { reason: "customer left" },
          },
        });
        expect(
          recording.callsOf("completeRun").map((call) => call.status)
        ).toEqual(["completed"]);
        expect(recording.terminationState?.status).toBe("running");
        expect(recording.callsOf("recordAuditEvent")).toHaveLength(0);
      })
  );

  it.effect(
    "records canceled at the Canceled outlet once the caller has run it",
    () =>
      Effect.gen(function* () {
        const recording = createRecordingWorkflowStore();
        recording.terminationState = {
          status: "running",
          claim: cancelClaim,
          didWrite: false,
        };

        const result = yield* recordRunCompleted({
          ...terminalInput,
          status: "canceled",
          store: recording,
        });

        expect(result).toEqual({ status: "canceled" });
        expect(recording.callsOf("recordAuditEvent")).toEqual([
          expect.objectContaining({
            eventType: "run_cancelled",
            message: "Run canceled at the Canceled outlet",
          }),
        ]);
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

          const result = yield* recordRunFailed({
            ...fatalInput,
            failure: { kind, message: "outcome read exhausted its retries" },
            outcome: { kind: "failed" },
            store: recording,
          });

          expect(result).toEqual({
            status: "running",
            cancelClaim: {
              eventName: "billing/subscription.canceled",
              payload: { reason: "customer left" },
            },
          });
          expect(
            recording.callsOf("completeRun").map((call) => call.status)
          ).toEqual(["failed"]);
          expect(recording.terminationState?.status).toBe("running");
          expect(recording.callsOf("recordAuditEvent")).toHaveLength(0);
        }
      })
  );

  it.effect(
    "records a fatal run that had entered the Canceled outlet as canceled there",
    () =>
      Effect.gen(function* () {
        const recording = createRecordingWorkflowStore();
        recording.terminationState = {
          status: "running",
          claim: cancelClaim,
          didWrite: false,
        };

        const result = yield* recordRunFailed({
          ...fatalInput,
          outcome: { kind: "canceled", outlet: "entered" },
          store: recording,
        });

        expect(result).toEqual({ status: "canceled" });
        expect(
          recording.callsOf("completeRun").map((call) => call.status)
        ).toEqual(["canceled"]);
        expect(recording.callsOf("recordAuditEvent")).toEqual([
          expect.objectContaining({
            eventType: "run_cancelled",
            message:
              "Run canceled at the Canceled outlet, then ended on a fatal error",
            metadata: expect.objectContaining({ canceledOutlet: "entered" }),
          }),
        ]);
      })
  );

  it.effect(
    "records canceled at the Canceled outlet after a fatal error once the caller has run it",
    () =>
      Effect.gen(function* () {
        const recording = createRecordingWorkflowStore();
        recording.terminationState = {
          status: "running",
          claim: cancelClaim,
          didWrite: false,
        };

        const result = yield* recordRunFailed({
          ...fatalInput,
          outcome: { kind: "canceled", outlet: "ran" },
          store: recording,
        });

        expect(result).toEqual({ status: "canceled" });
        expect(
          recording.callsOf("completeRun").map((call) => call.status)
        ).toEqual(["canceled"]);
        expect(recording.callsOf("recordAuditEvent")).toEqual([
          {
            workflowId: "workflow_1",
            executionId: "exec_1",
            eventType: "run_cancelled",
            message: "Run canceled at the Canceled outlet after a fatal error",
            metadata: {
              error: "outcome read exhausted its retries",
              failureKind: "failure",
              runMode: "live",
              canceledOutlet: "ran",
            },
          },
        ]);
      })
  );

  it.effect(
    "says the Canceled outlet failed when the caller reports it did",
    () =>
      Effect.gen(function* () {
        const recording = createRecordingWorkflowStore();
        recording.terminationState = {
          status: "running",
          claim: cancelClaim,
          didWrite: false,
        };

        const result = yield* recordRunFailed({
          ...fatalInput,
          outcome: { kind: "canceled", outlet: "failed" },
          store: recording,
        });

        expect(result).toEqual({ status: "canceled" });
        expect(recording.callsOf("recordAuditEvent")).toEqual([
          expect.objectContaining({
            eventType: "run_cancelled",
            message:
              "Run canceled after a fatal error; the Canceled outlet failed",
            metadata: expect.objectContaining({ canceledOutlet: "failed" }),
          }),
        ]);
      })
  );

  it.effect(
    "fails so the step retries when the exited write of a fatal run is refused",
    () =>
      Effect.gen(function* () {
        const databaseError = new DatabaseError({
          cause: new Error("connection interrupted"),
        });
        const recording = createRecordingWorkflowStore();
        // An Exit claim refuses the `failed` verdict, and the claimed `exited`
        // status is written in place because no graph outlet answers an Exit.
        recording.terminationState = {
          status: "running",
          claim: exitClaim,
          didWrite: false,
        };
        let call = 0;
        const store: WorkflowStore = {
          ...recording,
          completeRun: (input) => {
            call += 1;
            return call === 1
              ? recording.completeRun(input)
              : Effect.fail(databaseError);
          },
        };

        const failure = yield* Effect.flip(
          recordRunFailed({
            ...fatalInput,
            outcome: { kind: "failed" },
            store,
          })
        );

        expect(failure).toBe(databaseError);
        expect(call).toBe(2);
        expect(recording.callsOf("recordAuditEvent")).toHaveLength(0);
      })
  );

  it.effect(
    "returns Exit details but skips the audit when another writer won",
    () =>
      Effect.gen(function* () {
        const recording = createRecordingWorkflowStore();
        const store: WorkflowStore = {
          ...recording,
          completeRun: () =>
            Effect.succeed({
              status: "exited",
              claim: {
                kind: "exit",
                requestedAt: "2026-10-19T15:00:00.000Z",
                reason: "entity_not_found",
                nodeId: "send-reminder",
              },
              didWrite: false,
            }),
        };
        const recordingLoggerLayer = recordingLogger();

        const result = yield* recordRunCompleted({
          ...terminalInput,
          store,
          exitContext: {
            entityType: "appointment",
            conditionId: "condition_1",
          },
        }).pipe(Effect.provide(recordingLoggerLayer.layer));

        expect(result).toEqual({
          status: "exited",
          exit: {
            reason: "entity_not_found",
            entityType: "appointment",
            conditionId: "condition_1",
            nodeId: "send-reminder",
            checkedAt: "2026-10-19T15:00:00.000Z",
          },
        });
        expect(recordingLoggerLayer.lines).toEqual([
          {
            level: "Info",
            message: "Run did not claim the terminal record",
            properties: { status: "exited" },
          },
        ]);
        expect(recording.callsOf("recordAuditEvent")).toHaveLength(0);
      })
  );
});
