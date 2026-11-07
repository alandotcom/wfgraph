import { assert, describe, expect, it, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type {
  ExecutionRepo,
  WorkflowExecution,
} from "#src/backend/services/executions/repo";
import { InternalFailure } from "#src/backend/lib/effect/failures";
import {
  SilentAppLoggerLayer,
  stubExecutionRepo,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import type { WorkflowVersion } from "#src/backend/lib/db/schema";
import type { WorkflowRepo } from "#src/backend/services/workflows/repo";
import {
  buildIgnoredRunAuditMessage,
  buildRunStartedAuditMessage,
  recordPausedRunIgnored,
  runStartedEntry,
} from "#src/backend/services/executions/run-rows";

function createExecution(
  overrides: Partial<WorkflowExecution> = {}
): WorkflowExecution {
  return {
    id: "exec_1",
    workflowId: "wf_1",
    deliveryId: null,
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
 * The `workflow_versions` row a fixture start's `workflowVersionId` names,
 * which `runStartedEntry` reads to name the version on the timeline.
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
        lastPinnedAt: null,
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
describe("runStartedEntry", () => {
  layer(SilentAppLoggerLayer)((serviceIt) => {
    // Every field of the entry comes off the row about to be opened, so the
    // entry `startForEntity` writes beside that row describes it exactly.
    serviceIt.effect(
      "words the opening entry from the row it is opened with",
      () =>
        Effect.gen(function* () {
          const entry = yield* runStartedEntry({
            workflowId: "wf_1",
            workflowVersionId: "ver_1",
            startSource: "event",
            runMode: "test",
            startEventName: "app/appointment.created",
            entityType: "appointment",
            entityId: "appt_8813",
            deliveryId: "dlv_1",
            input: {},
          }).pipe(Effect.provide(pinnedVersionLayer()));

          assert.strictEqual(
            entry.message,
            "Event-triggered run of v3 started for app/appointment.created, to test recipients"
          );
          // `entityId` is the host's own record id and stays off the timeline.
          assert.deepStrictEqual(entry.metadata, {
            startSource: "event",
            runMode: "test",
            versionKind: "published",
            versionNumber: 3,
            eventName: "app/appointment.created",
            entityType: "appointment",
            deliveryId: "dlv_1",
          });
        })
    );

    // The label is read from the version id the row will pin, so a caller has
    // no way to name a version other than the one its run pins.
    serviceIt.effect("names the version the row will pin", () =>
      Effect.gen(function* () {
        const versionIds: string[] = [];

        const entry = yield* runStartedEntry({
          workflowId: "wf_1",
          workflowVersionId: "ver_7",
          startSource: "manual",
          runMode: "live",
          input: {},
        }).pipe(
          Effect.provide(
            stubWorkflowRepo({
              findVersionById: (versionId) =>
                Effect.sync(() => {
                  versionIds.push(versionId);
                  return {
                    id: versionId,
                    workflowId: "wf_1",
                    version: 7,
                    kind: "published" as const,
                    graph: { nodes: [], edges: [] },
                    catalogFingerprint: "fp",
                    graphDigest: "digest",
                    publishedAt: new Date("2026-03-01T00:00:00.000Z"),
                    lastPinnedAt: null,
                  };
                }),
            })
          )
        );

        assert.deepStrictEqual(versionIds, ["ver_7"]);
        assert.strictEqual(
          entry.message,
          "Manual run of v7 started, to real recipients"
        );
      })
    );

    // A run's version row cascades with the run, so a start naming a version
    // that is gone is an invariant break, and no row is opened for it.
    serviceIt.effect("fails when the version the row would pin is gone", () =>
      Effect.gen(function* () {
        const failure = yield* runStartedEntry({
          workflowId: "wf_1",
          workflowVersionId: "ver_gone",
          startSource: "manual",
          runMode: "live",
          input: {},
        }).pipe(
          Effect.provide(
            stubWorkflowRepo({ findVersionById: () => Effect.succeed(null) })
          ),
          Effect.flip
        );

        assert.instanceOf(failure, InternalFailure);
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
