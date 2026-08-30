// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import type { Workflow } from "#src/backend/lib/db/schema";
import { defineEvent } from "#src/backend/extensions/define-event";
import {
  SilentAppLoggerLayer,
  stubExecutionRepo,
  stubExtensions,
  stubInngestClient,
  stubIntegrationRepo,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import type { ExecutionRepo } from "#src/backend/services/executions/repo";
import type { WorkflowRepo } from "#src/backend/services/workflows/repo";
import type { WorkflowExecution } from "#src/backend/services/executions/repo/contracts";
import { postWorkflowExecute } from "#src/backend/services/workflows/lifecycle/manual-start";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import type { LifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { LIFECYCLE_STARTED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";

function graphWithRules(rules: LifecycleRules) {
  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: "lifecycle-1",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: {
          label: "Appointment",
          type: "lifecycle",
          config: { lifecycleRules: rules },
        },
      },
    ],
    edges: [],
  });
}

const startRules: LifecycleRules = {
  startEvents: ["app/appointment.created"],
  cancelEvents: [],
  concurrency: "newest-wins",
  allowManualStart: true,
};

/**
 * A stored workflow, one save later than the last one this file built.
 *
 * Preflight memoises its graph checks on the workflow's id and `updatedAt`, so
 * two fixtures sharing both are one workflow as far as it is concerned and the
 * second case would read the first's verdict.
 */
let savedAt = Date.UTC(2026, 1, 1);

function workflowRow(overrides: Partial<Workflow> = {}): Workflow {
  savedAt += 1000;

  return {
    id: "wf_1",
    name: "Appointment Reminders",
    description: null,
    graph: graphWithRules(startRules),
    isPaused: false,
    mode: "live",
    visibility: "private",
    publishedVersionId: "ver_1",
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
    updatedAt: new Date(savedAt),
    ...overrides,
  };
}

function executionRow(overrides: Partial<WorkflowExecution> = {}) {
  return {
    id: "exec_new",
    workflowId: "wf_1",
    workflowRunId: null,
    deliveryId: null,
    enqueuedAt: null,
    status: "running" as const,
    startSource: "manual" as const,
    runMode: "live" as const,
    startEventName: null,
    entityValue: null,
    input: {},
    output: null,
    error: null,
    startedAt: new Date("2026-03-01T00:00:00.000Z"),
    waitingAt: null,
    cancelledAt: null,
    completedAt: null,
    duration: null,
    cancelRequestedAt: null,
    cancelEventName: null,
    cancelPayload: null,
    workflowVersionId: "ver_1",
    ...overrides,
  } satisfies WorkflowExecution;
}

type StartInput = Parameters<ExecutionRepo["Service"]["startForEntity"]>[0];
type AuditInput = Parameters<ExecutionRepo["Service"]["recordAuditEvent"]>[0];
type TerminalInput = Parameters<ExecutionRepo["Service"]["insertTerminal"]>[0];

/**
 * The repository, keeping what the run was opened with.
 *
 * `startForEntity` is where the entity decision becomes visible, and the audit
 * rows are where a refusal does. Built per test, so no case reads another's.
 */
function makeRepo(overrides: Partial<ExecutionRepo["Service"]> = {}) {
  const starts: StartInput[] = [];
  const audits: AuditInput[] = [];
  const terminals: TerminalInput[] = [];

  return {
    starts,
    audits,
    terminals,
    layer: Layer.mergeAll(
      stubExecutionRepo({
        startForEntity: (input) =>
          Effect.sync(() => {
            starts.push(input);
            return {
              status: "started" as const,
              execution: executionRow(),
              supersededExecutionIds: [],
              reclaimedExecutionIds: [],
            };
          }),
        insertTerminal: (input) =>
          Effect.sync(() => {
            terminals.push(input);
            return executionRow({ id: "exec_ignored", status: "completed" });
          }),
        markEnqueued: () => Effect.void,
        recordAuditEvent: (input) =>
          Effect.sync(() => {
            audits.push(input);
          }),
        ...overrides,
      }),
      stubInngestClient({
        sendRunRequested: () => Effect.succeed({ eventId: "evt_1" }),
      })
    ),
  };
}

/**
 * The Event as the app defines it, which is what the payload gate decodes
 * against. The catalog metadata beside it is what the entity read uses, so a
 * test naming an Event needs both halves to agree.
 */
const appointmentCreated = defineEvent({
  name: "app/appointment.created",
  label: "Appointment created",
  correlationPath: "appointment.id",
  schema: Schema.Struct({
    appointment: Schema.Struct({
      id: Schema.String,
      startsAt: Schema.String,
    }),
  }),
});

const catalogLayer = stubExtensions({
  catalog: {
    events: [
      {
        name: "app/appointment.created",
        label: "Appointment created",
        correlationPath: "appointment.id",
        payloadFields: [],
      },
    ],
    actions: [],
    integrations: [],
  },
  events: [appointmentCreated],
  eventByName: (name) =>
    name === appointmentCreated.name ? appointmentCreated : undefined,
});

const validPayload = {
  appointment: { id: "appt_1", startsAt: "2026-08-01T18:00:00.000Z" },
};

/** A graph whose split routes on the Event a run arrived on. */
function graphWithEventSplit() {
  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: "lifecycle-1",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: {
          label: "Appointment",
          type: "lifecycle",
          config: { lifecycleRules: startRules },
        },
      },
      {
        id: "split-1",
        type: "action",
        position: { x: 0, y: 200 },
        data: {
          label: "Event Split",
          type: "action",
          config: { actionType: BUILT_IN_ACTION_IDS.eventSplit },
        },
      },
    ],
    edges: [
      {
        id: "edge-1",
        source: "lifecycle-1",
        target: "split-1",
        sourceHandle: LIFECYCLE_STARTED_HANDLE,
      },
    ],
  });
}

type SnapshotInput = Parameters<
  WorkflowRepo["Service"]["freezeDraftSnapshot"]
>[0];

/**
 * The repository a draft run reads. It returns the workflow paired with the
 * graph the canvas holds, plus the snapshot row the run then pins to.
 *
 * The published reads are left unstubbed, so a draft start that reached one
 * dies on the stub instead of running the reviewed graph.
 */
function makeDraftRepo(workflow: Workflow) {
  const snapshots: SnapshotInput[] = [];
  const released: string[] = [];

  return {
    snapshots,
    released,
    layer: stubWorkflowRepo({
      findByIdWithDraftGraphForRun: () =>
        Effect.succeed({ workflow, draftGraph: workflow.graph }),
      deleteUnreferencedDraftSnapshot: (versionId) =>
        Effect.sync(() => {
          released.push(versionId);
          return true;
        }),
      freezeDraftSnapshot: (input) =>
        Effect.sync(() => {
          snapshots.push(input);
          return {
            id: input.versionId,
            workflowId: input.workflowId,
            version: null,
            kind: "draft_snapshot" as const,
            graph: input.graph,
            catalogFingerprint: input.catalogFingerprint,
            graphDigest: input.graphDigest,
            publishedAt: new Date("2026-03-01T00:00:00.000Z"),
          };
        }),
    }),
  };
}

/** A graph that fails validation because its action node names no action. */
function graphWithUnconfiguredAction() {
  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: "lifecycle-1",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: {
          label: "Appointment",
          type: "lifecycle",
          config: { lifecycleRules: startRules },
        },
      },
      {
        id: "action-1",
        type: "action",
        position: { x: 0, y: 200 },
        data: { label: "Send reminder", type: "action", config: {} },
      },
    ],
    edges: [
      {
        id: "edge-1",
        source: "lifecycle-1",
        target: "action-1",
        sourceHandle: LIFECYCLE_STARTED_HANDLE,
      },
    ],
  });
}

function workflowLayer(workflow: Workflow) {
  return stubWorkflowRepo({
    findById: () => Effect.succeed(workflow),
    findByIdWithPublishedVersionForRun: () =>
      Effect.succeed({
        workflow,
        publishedVersion: {
          id: "ver_1",
          workflowId: workflow.id,
          version: 1,
          kind: "published",
          graph: workflow.graph,
          catalogFingerprint: "fp",
          graphDigest: "digest",
          publishedAt: new Date("2026-03-01T00:00:00.000Z"),
        },
      }),
    findPublishedVersion: () =>
      Effect.succeed({
        id: "ver_1",
        workflowId: workflow.id,
        version: 1,
        kind: "published",
        graph: workflow.graph,
        catalogFingerprint: "fp",
        graphDigest: "digest",
        publishedAt: new Date("2026-03-01T00:00:00.000Z"),
      }),
  });
}

describe("postWorkflowExecute", () => {
  layer(
    Layer.mergeAll(SilentAppLoggerLayer, catalogLayer, stubIntegrationRepo())
  )((it) => {
    // A manual run stands in for an Event, so it is about whatever its payload
    // is about. This is what makes a test run supersede the run it is testing
    // rather than sit beside it.
    it.effect("takes its entity from the Start Event's Correlation Path", () =>
      Effect.gen(function* () {
        const repo = makeRepo();

        const response = yield* postWorkflowExecute("wf_1", {
          input: { appointment: { id: "appt_1" } },
        }).pipe(
          Effect.provide(
            Layer.mergeAll(repo.layer, workflowLayer(workflowRow()))
          )
        );

        assert.strictEqual(repo.starts[0]?.execution.entityValue, "appt_1");
        assert.strictEqual(
          repo.starts[0]?.execution.workflowVersionId,
          "ver_1"
        );
        assert.deepStrictEqual(response, {
          status: "running",
          executionId: "exec_new",
          runId: "evt_1",
          runMode: "live",
        });
      })
    );

    // The entity space is shared with values a sender controls, so the fallback
    // is namespaced: a bare id would let a payload claim to be the workflow's
    // own entity.
    it.effect("falls back to the workflow itself, under a namespace", () =>
      Effect.gen(function* () {
        const repo = makeRepo();

        yield* postWorkflowExecute("wf_1", { input: { nothing: "here" } }).pipe(
          Effect.provide(
            Layer.mergeAll(repo.layer, workflowLayer(workflowRow()))
          )
        );

        assert.strictEqual(
          repo.starts[0]?.execution.entityValue,
          "workflow:wf_1"
        );
      })
    );

    // A graph the Lifecycle panel has never been near is one the Run button is
    // how anybody tries.
    it.effect("runs a workflow whose entry node carries no rules", () =>
      Effect.gen(function* () {
        const repo = makeRepo();

        const response = yield* postWorkflowExecute("wf_1", {}).pipe(
          Effect.provide(
            Layer.mergeAll(
              repo.layer,
              workflowLayer(
                workflowRow({
                  graph: createSerializedWorkflowGraph({
                    nodes: [
                      {
                        id: "lifecycle-1",
                        type: "lifecycle",
                        position: { x: 0, y: 0 },
                        data: { label: "Start", type: "lifecycle", config: {} },
                      },
                    ],
                    edges: [],
                  }),
                })
              )
            )
          )
        );

        assert.strictEqual(response.status, "running");
        // No rules means no Concurrency to compare on, so the entity is the
        // workflow's own namespaced id.
        assert.strictEqual(
          repo.starts[0]?.execution.entityValue,
          "workflow:wf_1"
        );
      })
    );

    // A paused workflow gets a terminal run rather than a Refused Start: the
    // runs list is the only feedback the Run button gives, and a decision with
    // no row reads there as nothing having happened.
    it.effect("writes a paused workflow an ignored run, not a refusal", () =>
      Effect.gen(function* () {
        const repo = makeRepo();

        const response = yield* postWorkflowExecute("wf_1", {}).pipe(
          Effect.provide(
            Layer.mergeAll(
              repo.layer,
              workflowLayer(workflowRow({ isPaused: true }))
            )
          )
        );

        assert.deepStrictEqual(response, {
          status: "ignored",
          executionId: "exec_ignored",
          runMode: "live",
          reason: "workflow_paused",
        });
        assert.strictEqual(repo.terminals[0]?.status, "completed");
        assert.deepStrictEqual(repo.starts, []);
        assert.deepStrictEqual(
          repo.audits.map((audit) => audit.eventType),
          ["run_ignored"]
        );
      })
    );

    // The workflow's own checkbox declining, which the Refused Starts panel has
    // to hold for the same as the two the engine decides.
    it.effect("refuses a manual start the rules leave out", () =>
      Effect.gen(function* () {
        const repo = makeRepo();

        const row = workflowRow({
          graph: graphWithRules({ ...startRules, allowManualStart: false }),
        });

        const response = yield* postWorkflowExecute("wf_1", {}).pipe(
          Effect.provide(Layer.mergeAll(repo.layer, workflowLayer(row)))
        );

        assert.deepStrictEqual(response, {
          status: "ignored",
          runMode: "live",
          reason: "manual_start_not_allowed",
        });
        assert.deepStrictEqual(repo.starts, []);
        assert.deepStrictEqual(repo.terminals, []);

        const audit = repo.audits[0];
        assert.strictEqual(audit?.eventType, "run_refused");
        assert.isUndefined(audit?.executionId);
        assert.strictEqual(audit?.metadata?.reason, "manual_start_not_allowed");
        assert.include(audit?.message, "does not list manual runs");
      })
    );

    // The Event is what an Event Split routes on, so a run naming one travels
    // the same branches the real arrival would.
    it.effect("carries the Event it stands in for onto the run", () =>
      Effect.gen(function* () {
        const repo = makeRepo();

        const response = yield* postWorkflowExecute("wf_1", {
          input: validPayload,
          eventName: "app/appointment.created",
        }).pipe(
          Effect.provide(
            Layer.mergeAll(repo.layer, workflowLayer(workflowRow()))
          )
        );

        assert.strictEqual(response.status, "running");
        assert.strictEqual(
          repo.starts[0]?.execution.startEventName,
          "app/appointment.created"
        );
        assert.strictEqual(repo.starts[0]?.execution.entityValue, "appt_1");
      })
    );

    // Naming an Event the workflow does not start on is a malformed request
    // rather than a lifecycle decision, so it leaves no row at all.
    it.effect("refuses an Event this workflow does not start on", () =>
      Effect.gen(function* () {
        const repo = makeRepo();

        const failure = yield* postWorkflowExecute("wf_1", {
          input: validPayload,
          eventName: "app/appointment.cancelled",
        }).pipe(
          Effect.provide(
            Layer.mergeAll(repo.layer, workflowLayer(workflowRow()))
          ),
          Effect.flip
        );

        assert.strictEqual(failure.kind, "invalid");
        assert.include(failure.payload.error, "does not start this workflow");
        assert.deepStrictEqual(repo.starts, []);
        assert.deepStrictEqual(repo.audits, []);
      })
    );

    // The Event's own schema is the gate, the same one the delivery path runs a
    // real arrival through.
    it.effect("refuses a payload the Event's schema turns away", () =>
      Effect.gen(function* () {
        const repo = makeRepo();

        const failure = yield* postWorkflowExecute("wf_1", {
          input: { appointment: { id: "appt_1" } },
          eventName: "app/appointment.created",
        }).pipe(
          Effect.provide(
            Layer.mergeAll(repo.layer, workflowLayer(workflowRow()))
          ),
          Effect.flip
        );

        assert.strictEqual(failure.kind, "invalid");
        assert.include(
          failure.payload.error,
          'Payload refused for Event "app/appointment.created"'
        );
        assert.deepStrictEqual(repo.starts, []);
      })
    );

    // Such a run reaches the split and leaves by no outlet, so everything behind
    // it would go unrun with nothing said.
    it.effect("refuses an Event-less run into a graph that splits", () =>
      Effect.gen(function* () {
        const repo = makeRepo();

        const response = yield* postWorkflowExecute("wf_1", {}).pipe(
          Effect.provide(
            Layer.mergeAll(
              repo.layer,
              workflowLayer(workflowRow({ graph: graphWithEventSplit() }))
            )
          )
        );

        assert.deepStrictEqual(response, {
          status: "ignored",
          runMode: "live",
          reason: "start_event_required",
        });
        assert.deepStrictEqual(repo.starts, []);
        assert.strictEqual(
          repo.audits[0]?.metadata?.reason,
          "start_event_required"
        );
      })
    );

    it.effect("starts a run that names its Event into the same graph", () =>
      Effect.gen(function* () {
        const repo = makeRepo();

        const response = yield* postWorkflowExecute("wf_1", {
          input: validPayload,
          eventName: "app/appointment.created",
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              repo.layer,
              workflowLayer(workflowRow({ graph: graphWithEventSplit() }))
            )
          )
        );

        assert.strictEqual(response.status, "running");
      })
    );

    // A test-mode run travels the graph on the canvas, pinned to a snapshot of
    // it. An unpublished workflow is runnable that way, and a published one
    // keeps serving its Events unchanged.
    it.effect("runs the draft graph, pinned to a snapshot of it", () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const row = workflowRow({ mode: "test", publishedVersionId: null });
        const workflows = makeDraftRepo(row);

        const response = yield* postWorkflowExecute("wf_1", {
          input: { appointment: { id: "appt_1" } },
          graph: "draft",
        }).pipe(Effect.provide(Layer.mergeAll(repo.layer, workflows.layer)));

        assert.strictEqual(response.status, "running");
        assert.strictEqual(response.runMode, "test");

        const snapshot = workflows.snapshots[0];
        assert.deepStrictEqual(snapshot?.graph, row.graph);
        assert.strictEqual(snapshot?.workflowId, "wf_1");
        // The run references the row minted above, so the engine replays the
        // graph the builder was looking at instead of the published graph.
        assert.strictEqual(
          repo.starts[0]?.execution.workflowVersionId,
          snapshot?.versionId
        );
      })
    );

    // The run command decides which recipients a draft run reaches, and the
    // workflow's Published mode does not. An unreviewed graph uses test
    // recipients even while the published version serves Events live.
    it.effect("runs a live workflow's draft against test recipients", () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const workflows = makeDraftRepo(workflowRow({ mode: "live" }));

        const response = yield* postWorkflowExecute("wf_1", {
          graph: "draft",
        }).pipe(Effect.provide(Layer.mergeAll(repo.layer, workflows.layer)));

        assert.strictEqual(response.status, "running");
        assert.strictEqual(response.runMode, "test");
        // The row and the Inngest event carry the same run mode as the response.
        assert.strictEqual(repo.starts[0]?.execution.runMode, "test");
        assert.strictEqual(workflows.snapshots.length, 1);
      })
    );

    // A run of the published version reads the workflow's Published mode, the
    // same mode Events read.
    it.effect("runs the published version in the workflow's mode", () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const row = workflowRow({ mode: "live" });

        const response = yield* postWorkflowExecute("wf_1", {}).pipe(
          Effect.provide(Layer.mergeAll(repo.layer, workflowLayer(row)))
        );

        assert.strictEqual(response.status, "running");
        assert.strictEqual(response.runMode, "live");
      })
    );

    // The draft goes through the checks Publish runs and fails them the same
    // way. The message names the node, and no snapshot is written.
    it.effect("refuses a broken draft without minting a snapshot", () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const workflows = makeDraftRepo(
          workflowRow({ mode: "test", graph: graphWithUnconfiguredAction() })
        );

        const failure = yield* postWorkflowExecute("wf_1", {
          graph: "draft",
        }).pipe(
          Effect.provide(Layer.mergeAll(repo.layer, workflows.layer)),
          Effect.flip
        );

        assert.strictEqual(failure.kind, "invalid");
        assert.include(failure.payload.error, "has no action selected");
        assert.deepStrictEqual(workflows.snapshots, []);
        assert.deepStrictEqual(repo.starts, []);
      })
    );

    // The snapshot is written only once a row is about to reference it. The
    // lifecycle gates can turn a start away after preflight, as they do here for
    // a payload the Start Event refuses. The Test Run overlay retries such a
    // start, so an earlier write would leave a full copy of the graph behind on
    // every attempt.
    it.effect("leaves no snapshot behind a start refused after preflight", () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const workflows = makeDraftRepo(workflowRow({ mode: "test" }));

        const failure = yield* postWorkflowExecute("wf_1", {
          graph: "draft",
          eventName: "app/appointment.created",
          input: { appointment: { id: 42 } },
        }).pipe(
          Effect.provide(Layer.mergeAll(repo.layer, workflows.layer)),
          Effect.flip
        );

        assert.strictEqual(failure.kind, "invalid");
        assert.deepStrictEqual(workflows.snapshots, []);
        assert.deepStrictEqual(repo.starts, []);
      })
    );

    // Concurrency decides after the pin, because the Execution it opens
    // references the version. A first-wins refusal therefore has a snapshot to
    // release, and releasing it avoids one graph copy per refused attempt.
    it.effect("releases the snapshot when Concurrency refuses the start", () =>
      Effect.gen(function* () {
        const repo = makeRepo({
          startForEntity: () =>
            Effect.succeed({
              status: "refused" as const,
              inFlightExecutionIds: ["exec_running"],
            }),
        });
        const workflows = makeDraftRepo(workflowRow({ mode: "test" }));

        const response = yield* postWorkflowExecute("wf_1", {
          graph: "draft",
        }).pipe(Effect.provide(Layer.mergeAll(repo.layer, workflows.layer)));

        assert.strictEqual(response.status, "ignored");
        assert.deepStrictEqual(workflows.released, [
          workflows.snapshots[0]?.versionId,
        ]);
      })
    );

    // A draft run passes through every gate a published run passes through. The
    // ignored run it writes pins to the snapshot, the same as a started run.
    it.effect("holds a paused workflow's draft run to the same gate", () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const workflows = makeDraftRepo(
          workflowRow({ mode: "live", isPaused: true })
        );

        const response = yield* postWorkflowExecute("wf_1", {
          graph: "draft",
        }).pipe(Effect.provide(Layer.mergeAll(repo.layer, workflows.layer)));

        assert.deepStrictEqual(response, {
          status: "ignored",
          executionId: "exec_ignored",
          runMode: "test",
          reason: "workflow_paused",
        });
        assert.strictEqual(
          repo.terminals[0]?.workflowVersionId,
          workflows.snapshots[0]?.versionId
        );
      })
    );

    // The run dialog names one version and one set of recipients. A publish or
    // a mode change while it is open would leave those words describing a run
    // nobody asked for, so the request repeats them and the server checks.
    it.effect("refuses a published run naming a version that has moved", () =>
      Effect.gen(function* () {
        const repo = makeRepo();

        const failure = yield* postWorkflowExecute("wf_1", {
          expected: { versionId: "ver_0", mode: "live" },
        }).pipe(
          Effect.provide(
            Layer.mergeAll(repo.layer, workflowLayer(workflowRow()))
          ),
          Effect.flip
        );

        assert.strictEqual(failure.kind, "conflict");
        assert.strictEqual(
          failure.payload.error,
          "The published version or the Published mode changed. Start the run again."
        );
        assert.deepStrictEqual(repo.starts, []);
      })
    );

    // The mode decides who the run reaches, so a stale one is refused for the
    // same reason a stale version is, even with the version id still current.
    it.effect("refuses a published run naming a mode that has moved", () =>
      Effect.gen(function* () {
        const repo = makeRepo();

        const failure = yield* postWorkflowExecute("wf_1", {
          expected: { versionId: "ver_1", mode: "test" },
        }).pipe(
          Effect.provide(
            Layer.mergeAll(repo.layer, workflowLayer(workflowRow()))
          ),
          Effect.flip
        );

        assert.strictEqual(failure.kind, "conflict");
        assert.deepStrictEqual(repo.starts, []);
      })
    );

    it.effect(
      "starts a published run naming the current version and mode",
      () =>
        Effect.gen(function* () {
          const repo = makeRepo();

          const response = yield* postWorkflowExecute("wf_1", {
            input: { appointment: { id: "appt_1" } },
            expected: { versionId: "ver_1", mode: "live" },
          }).pipe(
            Effect.provide(
              Layer.mergeAll(repo.layer, workflowLayer(workflowRow()))
            )
          );

          assert.strictEqual(response.status, "running");
          assert.strictEqual(
            repo.starts[0]?.execution.workflowVersionId,
            "ver_1"
          );
        })
    );

    // A draft run reads the canvas, which no publish and no mode change moves,
    // so the check does not apply to it.
    it.effect("runs a draft even when the published version has moved", () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const workflows = makeDraftRepo(workflowRow({ mode: "live" }));

        const response = yield* postWorkflowExecute("wf_1", {
          graph: "draft",
          expected: { versionId: "ver_0", mode: "test" },
        }).pipe(Effect.provide(Layer.mergeAll(repo.layer, workflows.layer)));

        assert.strictEqual(response.status, "running");
        assert.strictEqual(response.runMode, "test");
      })
    );
  });
});
