import { assert, describe, expect, it, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type {
  ExecutionRepo,
  WorkflowExecution,
} from "#src/backend/services/executions/repo";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { InternalFailure } from "#src/backend/lib/effect/failures";
import { InngestError } from "#src/backend/lib/effect/inngest-client";
import {
  makeRecordingLogger,
  SilentAppLoggerLayer,
  stubExecutionRepo,
  stubInngestClient,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import type { WorkflowVersion } from "#src/backend/lib/db/schema";
import type { WorkflowRepo } from "#src/backend/services/workflows/repo";
import {
  buildIgnoredRunAuditMessage,
  buildRunStartedAuditMessage,
  enqueueStartedRun,
  recordPausedRunIgnored,
} from "#src/backend/services/executions/run-rows";

function createExecution(
  overrides: Partial<WorkflowExecution> = {}
): WorkflowExecution {
  return {
    id: "exec_1",
    workflowId: "wf_1",
    workflowRunId: null,
    deliveryId: null,
    enqueuedAt: null,
    status: "running",
    startSource: "event",
    runMode: "live",
    startEventName: null,
    entityValue: null,
    entityType: null,
    entityId: null,
    input: {},
    output: null,
    error: null,
    startedAt: new Date("2026-03-01T00:00:00.000Z"),
    waitingAt: null,
    cancelledAt: null,
    completedAt: null,
    duration: null,
    terminationKind: null,
    terminationRequestedAt: null,
    terminationReason: null,
    terminationNodeId: null,
    cancelEventName: null,
    cancelPayload: null,
    workflowVersionId: "ver_1",
    ...overrides,
  };
}

/**
 * The `workflow_versions` row the fixture Execution's `workflowVersionId` names.
 *
 * The enqueue reads it to name the version on the timeline, so every case that
 * gets as far as the send provides one.
 */
function pinnedVersionLayer(
  version: Pick<WorkflowVersion, "id" | "version"> = {
    id: "ver_1",
    version: 3,
  }
): Layer.Layer<WorkflowRepo> {
  return stubWorkflowRepo({
    findVersionById: () =>
      Effect.succeed({
        ...version,
        workflowId: "wf_1",
        kind: "published",
        graph: { nodes: [], edges: [] },
        catalogFingerprint: "fp",
        graphDigest: "digest",
        publishedAt: new Date("2026-03-01T00:00:00.000Z"),
      }),
  });
}

describe("buildRunStartedAuditMessage", () => {
  it("names the start source that opened the run", () => {
    expect(
      buildRunStartedAuditMessage({ startSource: "manual", runMode: "live" })
    ).toBe("Manual run started, to real recipients");
    expect(
      buildRunStartedAuditMessage({ startSource: "schedule", runMode: "live" })
    ).toBe("Scheduled run started, to real recipients");
    expect(
      buildRunStartedAuditMessage({ startSource: "event", runMode: "live" })
    ).toBe("Event-triggered run started, to real recipients");
  });

  it("names the recipients a test run reached", () => {
    expect(
      buildRunStartedAuditMessage({ startSource: "event", runMode: "test" })
    ).toBe("Event-triggered run started, to test recipients");
  });

  // A Draft run of a Live workflow reaches test recipients, and so does a test
  // run of the published version. The pinned version is what tells the two rows
  // apart.
  it("names the Draft graph a snapshot run pinned", () => {
    expect(
      buildRunStartedAuditMessage({
        startSource: "manual",
        runMode: "test",
        version: { kind: "draft_snapshot", number: null },
      })
    ).toBe("Manual Draft run started, to test recipients");
  });

  it("names the published version by its number", () => {
    expect(
      buildRunStartedAuditMessage({
        startSource: "manual",
        runMode: "test",
        version: { kind: "published", number: 7 },
      })
    ).toBe("Manual run of v7 started, to test recipients");
  });

  it("appends the Event that started the run", () => {
    expect(
      buildRunStartedAuditMessage({
        startSource: "event",
        runMode: "test",
        eventName: "app/appointment.created",
        version: { kind: "published", number: 7 },
      })
    ).toBe(
      "Event-triggered run of v7 started for app/appointment.created, to test recipients"
    );
  });
});

describe("buildIgnoredRunAuditMessage", () => {
  it("uses the calling start source's own vocabulary", () => {
    expect(
      buildIgnoredRunAuditMessage({
        startSource: "manual",
        reason: "workflow_paused",
      })
    ).toBe("Ignored manual run because workflow is paused");
    expect(
      buildIgnoredRunAuditMessage({
        startSource: "event",
        reason: "workflow_paused",
      })
    ).toBe("Ignored event because workflow is paused");
  });

  // The refusal is the whole point of the row: without it, first-wins
  // Concurrency declining a start is invisible.
  it("says which Event first-wins Concurrency declined", () => {
    expect(
      buildIgnoredRunAuditMessage({
        startSource: "event",
        reason: "concurrency_first_wins",
        eventName: "app/appointment.created",
      })
    ).toBe(
      "Refused a start from event app/appointment.created: a run for this entity is already going and Concurrency is first-wins"
    );
    expect(
      buildIgnoredRunAuditMessage({
        startSource: "manual",
        reason: "concurrency_first_wins",
      })
    ).toBe(
      "Refused a start from manual run: a run for this entity is already going and Concurrency is first-wins"
    );
  });
});

// The two blocks below take their `it` from the `layer` callback, typed with the
// services that layer provides. The message builders above need no services and
// use the plain one imported at the top, so the callback parameter is named
// apart from it rather than shadowing it.
describe("enqueueStartedRun", () => {
  layer(SilentAppLoggerLayer)((serviceIt) => {
    serviceIt.effect("stores the event id the enqueue answered with", () =>
      Effect.gen(function* () {
        const calls = {
          runIds: [] as Array<{ executionId: string; runId: string | null }>,
        };

        // The row is opened by `ExecutionRepo.startForEntity`, under the lock that
        // makes Concurrency a decision; this is what happens after it exists.
        // `markEnqueueFailed` is left refusing, so a compensation on the happy
        // path would kill the test rather than pass unnoticed.
        const started = yield* enqueueStartedRun({
          execution: createExecution({ input: { order: "o1" } }),
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              pinnedVersionLayer(),
              stubExecutionRepo({
                markEnqueued: (input) =>
                  Effect.sync(() => {
                    calls.runIds.push(input);
                  }),
                recordAuditEvent: () => Effect.void,
              }),
              stubInngestClient({
                sendRunRequested: () => Effect.succeed({ eventId: "evt_1" }),
              })
            )
          )
        );

        assert.deepStrictEqual(started, {
          executionId: "exec_1",
          runId: "evt_1",
          runMode: "live",
        });
        assert.deepStrictEqual(calls.runIds, [
          { executionId: "exec_1", runId: "evt_1" },
        ]);
      })
    );

    // Every field of the entry comes off the committed row, which is what lets a
    // retried delivery send a row an earlier attempt opened and never sent
    // without rebuilding the start it was opened from.
    serviceIt.effect(
      "writes the opening timeline entry from the row alone",
      () =>
        Effect.gen(function* () {
          const calls = {
            audits: [] as Array<
              Parameters<ExecutionRepo["Service"]["recordAuditEvent"]>[0]
            >,
          };

          yield* enqueueStartedRun({
            execution: createExecution({
              runMode: "test",
              startEventName: "app/appointment.created",
              entityType: "appointment",
              entityId: "appt_8813",
              deliveryId: "dlv_1",
            }),
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                pinnedVersionLayer(),
                stubExecutionRepo({
                  markEnqueued: () => Effect.void,
                  recordAuditEvent: (input) =>
                    Effect.sync(() => {
                      calls.audits.push(input);
                    }),
                }),
                stubInngestClient({
                  sendRunRequested: () => Effect.succeed({ eventId: "evt_1" }),
                })
              )
            )
          );

          const audit = calls.audits[0];
          assert.isDefined(audit);
          assert.strictEqual(audit.eventType, "run_started");
          assert.strictEqual(
            audit.message,
            "Event-triggered run of v3 started for app/appointment.created, to test recipients"
          );
          // `entityId` is the host's own record id and stays off the timeline.
          assert.deepStrictEqual(audit.metadata, {
            startSource: "event",
            runMode: "test",
            versionKind: "published",
            versionNumber: 3,
            eventName: "app/appointment.created",
            entityType: "appointment",
            deliveryId: "dlv_1",
            runId: "evt_1",
          });
        })
    );

    // Two attempts of one delivery hand this the same row, and the attempt that
    // committed it may have loaded an older version than the one running now.
    // The label is read from the row's own version id, so a caller has no way to
    // name a version for a run it did not open.
    serviceIt.effect(
      "names the version the row pins, not the one the caller loaded",
      () =>
        Effect.gen(function* () {
          const calls = {
            versionIds: [] as string[],
            audits: [] as Array<
              Parameters<ExecutionRepo["Service"]["recordAuditEvent"]>[0]
            >,
          };

          yield* enqueueStartedRun({
            execution: createExecution({ workflowVersionId: "ver_1" }),
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                stubWorkflowRepo({
                  findVersionById: (versionId) =>
                    Effect.sync(() => {
                      calls.versionIds.push(versionId);
                      return {
                        id: "ver_1",
                        workflowId: "wf_1",
                        version: 1,
                        kind: "published" as const,
                        graph: { nodes: [], edges: [] },
                        catalogFingerprint: "fp",
                        graphDigest: "digest",
                        publishedAt: new Date("2026-03-01T00:00:00.000Z"),
                      };
                    }),
                }),
                stubExecutionRepo({
                  markEnqueued: () => Effect.void,
                  recordAuditEvent: (input) =>
                    Effect.sync(() => {
                      calls.audits.push(input);
                    }),
                }),
                stubInngestClient({
                  sendRunRequested: () => Effect.succeed({ eventId: "evt_1" }),
                })
              )
            )
          );

          assert.deepStrictEqual(calls.versionIds, ["ver_1"]);
          const audit = calls.audits[0];
          assert.isDefined(audit);
          assert.strictEqual(
            audit.message,
            "Event-triggered run of v1 started, to real recipients"
          );
          assert.deepInclude(audit.metadata, { versionNumber: 1 });
        })
    );

    // A retried delivery hands back the row an earlier attempt already sent, and
    // that run may be parked in a Wait. Sending again could only fail into the
    // compensation, which would stop a healthy run, and a second `markEnqueued`
    // and "run started" entry would misdate it.
    serviceIt.effect(
      "sends nothing and writes nothing for an enqueued row",
      () =>
        Effect.gen(function* () {
          const recorder = makeRecordingLogger();

          // Every repository method and Inngest call is left refusing, so any
          // send, stamp, timeline entry or version read kills the test.
          const started = yield* enqueueStartedRun({
            execution: createExecution({
              status: "waiting",
              enqueuedAt: new Date("2026-03-01T00:00:01.000Z"),
              workflowRunId: "evt_first",
            }),
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                stubWorkflowRepo(),
                stubExecutionRepo(),
                stubInngestClient(),
                recorder.layer
              )
            )
          );

          assert.deepStrictEqual(started, {
            executionId: "exec_1",
            runId: "evt_first",
            runMode: "live",
          });
          assert.deepStrictEqual(recorder.infoLines, [
            {
              message: "Skipped the send for a run the bus already took",
              properties: {
                run: { executionId: "exec_1", runId: "evt_first" },
              },
            },
          ]);
        })
    );

    // The version row cascades with the run it belongs to, so a row pointing at
    // a version that is gone is an invariant break. Sending the run anyway would
    // enqueue a run nothing can name.
    serviceIt.effect("fails when the version the row pins is gone", () =>
      Effect.gen(function* () {
        const failure = yield* enqueueStartedRun({
          execution: createExecution(),
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              // Every Inngest call is left refusing: nothing may reach the bus.
              stubWorkflowRepo({ findVersionById: () => Effect.succeed(null) }),
              stubExecutionRepo(),
              stubInngestClient()
            )
          ),
          Effect.flip
        );

        assert.instanceOf(failure, InternalFailure);
      })
    );

    // The row is closed before the failure travels on, so a run is never left
    // sitting in "running" with nothing behind it that could finish it.
    serviceIt.effect("closes the row when the enqueue is refused", () =>
      Effect.gen(function* () {
        const calls = {
          closed: [] as Array<{ executionId: string; error: string }>,
        };

        // `markEnqueued` is left refusing: no run reached the bus, and stamping
        // one as though it had would be the bug.
        const failure = yield* enqueueStartedRun({
          execution: createExecution(),
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              pinnedVersionLayer(),
              stubExecutionRepo({
                markEnqueueFailed: (input) =>
                  Effect.sync(() => {
                    calls.closed.push(input);
                    return true;
                  }),
              }),
              stubInngestClient({
                sendRunRequested: () =>
                  Effect.fail(
                    new InngestError({
                      cause: new Error("inngest dev server unreachable"),
                    })
                  ),
                sendCancelRequested: () => Effect.succeed({ eventId: "c_1" }),
              })
            )
          ),
          Effect.flip
        );

        assert.instanceOf(failure, InngestError);
        assert.deepStrictEqual(calls.closed, [
          { executionId: "exec_1", error: "inngest dev server unreachable" },
        ]);
      })
    );

    serviceIt.effect(
      "falls back to a fixed sentence when nothing was thrown",
      () =>
        Effect.gen(function* () {
          const calls = {
            closed: [] as Array<{ executionId: string; error: string }>,
          };

          yield* enqueueStartedRun({
            execution: createExecution(),
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                pinnedVersionLayer(),
                stubExecutionRepo({
                  markEnqueueFailed: (input) =>
                    Effect.sync(() => {
                      calls.closed.push(input);
                      return true;
                    }),
                }),
                stubInngestClient({
                  sendRunRequested: () =>
                    Effect.fail(new InngestError({ cause: "connection lost" })),
                  sendCancelRequested: () => Effect.succeed({ eventId: "c_1" }),
                })
              )
            ),
            Effect.flip
          );

          assert.deepStrictEqual(calls.closed, [
            { executionId: "exec_1", error: "Failed to enqueue run" },
          ]);
        })
    );

    // A refused send is ambiguous: Inngest may have taken the event and failed
    // on the way back, in which case the run is already executing and reached a
    // verdict the compensation may not overwrite. The line is how an operator
    // learns that is what happened.
    serviceIt.effect("says so when the run got to a verdict first", () =>
      Effect.gen(function* () {
        const recorder = makeRecordingLogger();

        yield* enqueueStartedRun({
          execution: createExecution(),
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              pinnedVersionLayer(),
              stubExecutionRepo({
                markEnqueueFailed: () => Effect.succeed(false),
              }),
              stubInngestClient({
                sendRunRequested: () =>
                  Effect.fail(
                    new InngestError({ cause: new Error("gateway timeout") })
                  ),
                sendCancelRequested: () => Effect.succeed({ eventId: "c_1" }),
              }),
              recorder.layer
            )
          ),
          Effect.flip
        );

        assert.deepStrictEqual(recorder.infoLines, [
          {
            message:
              "Enqueue reported failure but the run had already left the in-flight statuses",
            properties: { executionId: "exec_1" },
          },
        ]);
      })
    );

    // The in-flight guard on the close defers to a terminal status and nothing
    // more, so a run Inngest accepted a moment ago is `running` and the close
    // would relabel a live run. The cancel is what makes it true.
    serviceIt.effect("tells the run to stop before closing its row", () =>
      Effect.gen(function* () {
        const order: string[] = [];

        yield* enqueueStartedRun({
          execution: createExecution({
            startEventName: "app/appointment.created",
          }),
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              pinnedVersionLayer(),
              stubExecutionRepo({
                markEnqueueFailed: () =>
                  Effect.sync(() => {
                    order.push("close");
                    return true;
                  }),
              }),
              stubInngestClient({
                sendRunRequested: () =>
                  Effect.fail(
                    new InngestError({ cause: new Error("gateway timeout") })
                  ),
                sendCancelRequested: () =>
                  Effect.sync(() => {
                    order.push("cancel");
                    return { eventId: "c_1" };
                  }),
              })
            )
          ),
          Effect.flip
        );

        assert.deepStrictEqual(order, ["cancel", "close"]);
      })
    );

    // The enqueue is irreversible, so failing here would put the caller's Inngest
    // step into a retry that enqueues nothing new and re-runs everything around
    // it -- exactly how one arrival could open two Executions.
    serviceIt.effect(
      "reports the run as started when the writes after the send are refused",
      () =>
        Effect.gen(function* () {
          const recorder = makeRecordingLogger();

          const started = yield* enqueueStartedRun({
            execution: createExecution({ deliveryId: "dlv_1" }),
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                pinnedVersionLayer(),
                stubExecutionRepo({
                  markEnqueued: () =>
                    Effect.fail(
                      new DatabaseError({ cause: new Error("connection lost") })
                    ),
                  recordAuditEvent: () =>
                    Effect.fail(
                      new DatabaseError({ cause: new Error("connection lost") })
                    ),
                }),
                stubInngestClient({
                  sendRunRequested: () => Effect.succeed({ eventId: "evt_1" }),
                }),
                recorder.layer
              )
            )
          );

          assert.deepStrictEqual(started, {
            executionId: "exec_1",
            runId: "evt_1",
            runMode: "live",
          });
          assert.deepStrictEqual(
            recorder.lines.map((line) => line.message),
            [
              "The run is enqueued, but the database refused to record that the bus took the run",
              "The run is enqueued, but the database refused to write the run's opening timeline entry",
            ]
          );
        })
    );
  });
});

describe("recordPausedRunIgnored", () => {
  layer(SilentAppLoggerLayer)((serviceIt) => {
    // The runs list is the only feedback the manual and webhook entrypoints
    // give, so a paused workflow's request gets a row saying it was declined
    // rather than no row at all.
    serviceIt.effect("writes a terminal row carrying the reason", () =>
      Effect.gen(function* () {
        const calls = {
          terminals: [] as Array<
            Parameters<ExecutionRepo["Service"]["insertTerminal"]>[0]
          >,
        };

        const execution = yield* recordPausedRunIgnored({
          workflowId: "wf_1",
          workflowVersionId: "ver_1",
          startSource: "event",
          runMode: "test",
          payload: { order: "o1" },
        }).pipe(
          Effect.provide(
            stubExecutionRepo({
              insertTerminal: (input) =>
                Effect.sync(() => {
                  calls.terminals.push(input);
                  return createExecution({
                    id: "exec_ignored",
                    status: "completed",
                  });
                }),
              recordAuditEvent: () => Effect.void,
            })
          )
        );

        assert.strictEqual(execution.id, "exec_ignored");

        const recorded = calls.terminals[0];
        assert.isDefined(recorded);
        assert.strictEqual(recorded.workflowVersionId, "ver_1");
        assert.strictEqual(recorded.status, "completed");
        assert.strictEqual(recorded.startSource, "event");
        assert.strictEqual(recorded.runMode, "test");
        assert.deepStrictEqual(recorded.output, {
          status: "ignored",
          reason: "workflow_paused",
          runMode: "test",
        });
      })
    );
  });
});
