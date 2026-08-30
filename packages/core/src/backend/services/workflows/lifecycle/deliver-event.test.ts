import { assert, describe, layer } from "@effect/vitest";
// The mocks API has to be the one vitest itself exports; reaching it through the
// `@effect/vitest` re-export leaves it unable to find the module registry.
import { beforeEach, vi } from "vitest";
import { Effect, Layer } from "effect";
import type {
  PublishedWorkflowVersion,
  Workflow,
} from "#src/backend/lib/db/schema";
import { DatabaseError } from "#src/backend/lib/effect/database";
import type { InngestClient } from "#src/backend/lib/effect/inngest-client";
import {
  SilentAppLoggerLayer,
  stubExecutionRepo,
  stubExtensionCatalog,
  stubInngestClient,
  stubIntegrationRepo,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { LIFECYCLE_STARTED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import type { LifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type {
  EntityStartOutcome,
  ExecutionRepo,
  WorkflowExecution,
  WorkflowWaitState,
} from "#src/backend/services/executions/repo";
import type { EventSubscriber } from "#src/backend/services/workflows/repo";
import {
  applyLifecycleRules,
  deliverToWaits,
} from "#src/backend/services/workflows/lifecycle/deliver-event";

type Repo = ExecutionRepo["Service"];

const startForEntityMock = vi.fn<Repo["startForEntity"]>();
const requestCancelForEntityMock = vi.fn<Repo["requestCancelForEntity"]>();
const listWaitingStatesForExecutionsMock =
  vi.fn<Repo["listWaitingStatesForExecutions"]>();
const listWaitsForEventMock = vi.fn<Repo["listWaitsForEvent"]>();
const recordAuditEventMock = vi.fn<Repo["recordAuditEvent"]>(() => Effect.void);
const CLAIMED_AT = new Date("2026-03-01T00:01:00.000Z");
const claimWaitingStateByIdMock = vi.fn<Repo["claimWaitingStateById"]>(() =>
  Effect.succeed({
    waitState: parkedWait("claimed.event", {
      status: "resuming",
      resumedAt: CLAIMED_AT,
    }),
    claimedAt: CLAIMED_AT,
  })
);
const settleWaitingStateClaimMock = vi.fn<Repo["settleWaitingStateClaim"]>(() =>
  Effect.succeed(true)
);
const releaseWaitingStateClaimMock = vi.fn<Repo["releaseWaitingStateClaim"]>(
  () => Effect.succeed(true)
);
const markRunningMock = vi.fn<Repo["markRunning"]>(() => Effect.succeed(true));
const sendRunRequestedMock = vi.fn<
  InngestClient["Service"]["sendRunRequested"]
>(() => Effect.succeed({ eventId: "evt_1" }));
const sendCancelRequestedMock = vi.fn<
  InngestClient["Service"]["sendCancelRequested"]
>(() => Effect.void);
const sendWaitSignalMock = vi.fn<InngestClient["Service"]["sendWaitSignal"]>(
  () => Effect.void
);
const sendBranchKillMock = vi.fn<InngestClient["Service"]["sendBranchKill"]>(
  () => Effect.void
);

// The catalog the save rules are checked against, which preflight reads off the
// runtime the delivery runs on.
const catalogLayer = stubExtensionCatalog({
  events: [
    {
      name: "app/appointment.created",
      label: "Appointment created",
      correlationPath: "appointment.id",
      payloadFields: [],
    },
    {
      name: "app/appointment.canceled",
      label: "Appointment canceled",
      correlationPath: "appointment.id",
      payloadFields: [],
    },
  ],
});

const appointmentCreated = {
  name: "app/appointment.created",
  correlationPath: "appointment.id",
};

const appointmentCanceled = {
  name: "app/appointment.canceled",
  correlationPath: "appointment.id",
};

const payload = { appointment: { id: "appt_8813" } };

const startRules: LifecycleRules = {
  startEvents: ["app/appointment.created"],
  cancelEvents: [],
  concurrency: "unlimited",
};

const cancelRules: LifecycleRules = {
  startEvents: ["app/appointment.created"],
  cancelEvents: ["app/appointment.canceled"],
  concurrency: "unlimited",
};

function createExecution(
  overrides: Partial<WorkflowExecution> = {}
): WorkflowExecution {
  return {
    id: "exec_new",
    workflowId: "wf_1",
    workflowRunId: null,
    deliveryId: null,
    enqueuedAt: null,
    status: "running",
    startSource: "event",
    runMode: "live",
    startEventName: "app/appointment.created",
    entityValue: "appt_8813",
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
  };
}

const startedOutcome: EntityStartOutcome = {
  status: "started",
  execution: createExecution(),
  supersededExecutionIds: [],
  reclaimedExecutionIds: [],
};

/** The entry node, carrying the rules under test and nothing else. */
function lifecycleGraph(rules?: LifecycleRules): Workflow["graph"] {
  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: "lifecycle-1",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: {
          label: "Start",
          type: "lifecycle",
          config: rules ? { lifecycleRules: rules } : {},
        },
      },
    ],
    edges: [],
  });
}

function createWorkflow(input: {
  rules?: LifecycleRules;
  isPaused?: boolean;
  graph?: Workflow["graph"];
}): Workflow {
  return {
    id: "wf_1",
    name: "Appointment Reminders",
    description: null,
    graph: input.graph ?? lifecycleGraph(input.rules),
    isPaused: input.isPaused ?? false,
    mode: "live",
    visibility: "private",
    publishedVersionId: "ver_1",
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
  };
}

function publishedVersion(workflow: Workflow): PublishedWorkflowVersion {
  return {
    id: "ver_1",
    workflowId: workflow.id,
    version: 1,
    kind: "published",
    graph: workflow.graph,
    catalogFingerprint: "fp",
    graphDigest: "digest",
    publishedAt: new Date("2026-03-01T00:00:00.000Z"),
  };
}

/** A workflow repo answering both the draft row and its published version. */
function stubPublishedWorkflow(workflow: Workflow) {
  return stubWorkflowRepo({
    findById: () => Effect.succeed(workflow),
    findByIdWithPublishedVersionForRun: () =>
      Effect.succeed({
        workflow,
        publishedVersion: publishedVersion(workflow),
      }),
    findPublishedVersion: () => Effect.succeed(publishedVersion(workflow)),
  });
}

function subscriber(overrides: Partial<EventSubscriber> = {}): EventSubscriber {
  return {
    id: "wf_1",
    name: "Appointment Reminders",
    mode: "live",
    roles: ["start"],
    correlationPath: null,
    connectionId: null,
    ...overrides,
  };
}

/**
 * A parked wait whose match-free subscription wakes on the next occurrence.
 *
 * Resume matching's own cases live in `resume-waits.test.ts`; here the row only
 * has to be wakeable so the delivery's candidate query and exclusion are what
 * the assertion can see.
 */
function parkedWait(
  eventName: string,
  overrides: Partial<WorkflowWaitState> = {}
): WorkflowWaitState {
  return {
    id: "wait_1",
    executionId: "exec_parked",
    workflowId: "wf_1",
    runId: "run_1",
    nodeId: "node_wait",
    nodeName: "Wait",
    waitType: "event",
    status: "waiting",
    resumeToken: "token_1",
    waitUntil: null,
    subscribedEvents: [eventName],
    metadata: { waitFor: [{ event: eventName }] },
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    resumedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

/**
 * The ports `applyLifecycleRules` reaches through its real neighbours.
 *
 * Cancel's nudge and supersede signalling are stubbed quiet (empty waits, a
 * succeeding cancel send); their own suites own those behaviours.
 */
const lifecyclePorts = Layer.mergeAll(
  stubExecutionRepo({
    startForEntity: startForEntityMock,
    requestCancelForEntity: requestCancelForEntityMock,
    listWaitingStatesForExecutions: listWaitingStatesForExecutionsMock,
    recordAuditEvent: recordAuditEventMock,
    markEnqueued: () => Effect.void,
  }),
  stubInngestClient({
    sendRunRequested: sendRunRequestedMock,
    sendCancelRequested: sendCancelRequestedMock,
    sendWaitSignal: sendWaitSignalMock,
    sendBranchKill: sendBranchKillMock,
  }),
  stubIntegrationRepo()
);

const waitPorts = Layer.mergeAll(
  stubExecutionRepo({
    listWaitsForEvent: listWaitsForEventMock,
    claimWaitingStateById: claimWaitingStateByIdMock,
    settleWaitingStateClaim: settleWaitingStateClaimMock,
    releaseWaitingStateClaim: releaseWaitingStateClaimMock,
    markRunning: markRunningMock,
    recordAuditEvent: recordAuditEventMock,
  }),
  stubInngestClient({
    sendWaitSignal: sendWaitSignalMock,
  })
);

beforeEach(() => {
  startForEntityMock.mockReset();
  requestCancelForEntityMock.mockReset();
  listWaitingStatesForExecutionsMock.mockReset();
  listWaitsForEventMock.mockReset();
  recordAuditEventMock.mockReset();
  claimWaitingStateByIdMock.mockReset();
  settleWaitingStateClaimMock.mockReset();
  releaseWaitingStateClaimMock.mockReset();
  markRunningMock.mockReset();
  sendRunRequestedMock.mockReset();
  sendCancelRequestedMock.mockReset();
  sendWaitSignalMock.mockReset();
  sendBranchKillMock.mockReset();

  startForEntityMock.mockImplementation(() => Effect.succeed(startedOutcome));
  requestCancelForEntityMock.mockImplementation(() =>
    Effect.succeed(["exec_running"])
  );
  listWaitingStatesForExecutionsMock.mockImplementation(() =>
    Effect.succeed(new Map())
  );
  listWaitsForEventMock.mockImplementation(() => Effect.succeed([]));
  recordAuditEventMock.mockImplementation(() => Effect.void);
  claimWaitingStateByIdMock.mockImplementation(() =>
    Effect.succeed({
      waitState: parkedWait("claimed.event", {
        status: "resuming",
        resumedAt: CLAIMED_AT,
      }),
      claimedAt: CLAIMED_AT,
    })
  );
  settleWaitingStateClaimMock.mockImplementation(() => Effect.succeed(true));
  releaseWaitingStateClaimMock.mockImplementation(() => Effect.succeed(true));
  markRunningMock.mockImplementation(() => Effect.succeed(true));
  sendRunRequestedMock.mockImplementation(() =>
    Effect.succeed({ eventId: "evt_1" })
  );
  sendCancelRequestedMock.mockImplementation(() => Effect.void);
  sendWaitSignalMock.mockImplementation(() => Effect.void);
  sendBranchKillMock.mockImplementation(() => Effect.void);
});

describe("applyLifecycleRules", () => {
  layer(Layer.merge(SilentAppLoggerLayer, catalogLayer))((it) => {
    it.effect("starts a run where the Event holds the start role", () =>
      Effect.gen(function* () {
        const outcome = yield* applyLifecycleRules({
          subscriber: subscriber(),
          event: appointmentCreated,
          payload,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubPublishedWorkflow(createWorkflow({ rules: startRules })),
              lifecyclePorts
            )
          )
        );

        assert.deepStrictEqual(outcome, {
          kind: "started",
          workflowId: "wf_1",
          executionId: "exec_new",
          supersededExecutionIds: [],
          failedToSupersede: [],
        });
        assert.strictEqual(
          startForEntityMock.mock.calls[0]?.[0].execution.entityValue,
          "appt_8813"
        );
        assert.strictEqual(
          startForEntityMock.mock.calls[0]?.[0].execution.workflowVersionId,
          "ver_1"
        );
        assert.deepStrictEqual(sendRunRequestedMock.mock.calls[0]?.[0], {
          executionId: "exec_new",
        });
      })
    );

    it.effect("is waits_only when the arrival is a different Connection", () =>
      Effect.gen(function* () {
        const outcome = yield* applyLifecycleRules({
          subscriber: subscriber({ connectionId: "conn_1" }),
          event: { ...appointmentCreated, connectionId: "conn_other" },
          payload,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubPublishedWorkflow(createWorkflow({ rules: startRules })),
              lifecyclePorts
            )
          )
        );

        assert.deepStrictEqual(outcome, {
          kind: "waits_only",
          workflowId: "wf_1",
        });
        assert.strictEqual(startForEntityMock.mock.calls.length, 0);
      })
    );

    it.effect("starts when the arrival is the Connection the rules name", () =>
      Effect.gen(function* () {
        const outcome = yield* applyLifecycleRules({
          subscriber: subscriber({ connectionId: "conn_1" }),
          event: { ...appointmentCreated, connectionId: "conn_1" },
          payload,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubPublishedWorkflow(createWorkflow({ rules: startRules })),
              lifecyclePorts
            )
          )
        );

        assert.strictEqual(outcome.kind, "started");
      })
    );

    // A workflow answering an appointment being booked and being moved lists
    // both, and either one starts a run. Both read the same entity, so
    // newest-wins is what ends the run the earlier Event began.
    it.effect("starts a run on any of several Start Events", () =>
      Effect.gen(function* () {
        const outcome = yield* applyLifecycleRules({
          subscriber: subscriber(),
          event: appointmentCanceled,
          payload,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubPublishedWorkflow(
                createWorkflow({
                  rules: {
                    startEvents: [
                      "app/appointment.created",
                      "app/appointment.canceled",
                    ],
                    cancelEvents: [],
                    concurrency: "newest-wins",
                  },
                })
              ),
              lifecyclePorts
            )
          )
        );

        assert.strictEqual(outcome.kind, "started");
        assert.strictEqual(
          startForEntityMock.mock.calls[0]?.[0].execution.startEventName,
          "app/appointment.canceled"
        );
        assert.strictEqual(
          startForEntityMock.mock.calls[0]?.[0].concurrency,
          "newest-wins"
        );
      })
    );

    // Untrimmed, `" appt_1"` and `"appt_1"` would be two entities and Concurrency
    // would serialize neither against the other.
    it.effect("trims the Entity Value it reads", () =>
      Effect.gen(function* () {
        yield* applyLifecycleRules({
          subscriber: subscriber(),
          event: appointmentCreated,
          payload: { appointment: { id: "  appt_8813  " } },
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubPublishedWorkflow(createWorkflow({ rules: startRules })),
              lifecyclePorts
            )
          )
        );

        assert.strictEqual(
          startForEntityMock.mock.calls[0]?.[0].execution.entityValue,
          "appt_8813"
        );
      })
    );

    // A graph carrying no rules is every graph until the Lifecycle panel writes
    // them. It starts nothing, which is not the same as being unrunnable: runs
    // parked inside it still have Events owed to them.
    it.effect("treats a graph with no rules as starting nothing", () =>
      Effect.gen(function* () {
        const outcome = yield* applyLifecycleRules({
          subscriber: subscriber(),
          event: appointmentCreated,
          payload,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubPublishedWorkflow(createWorkflow({})),
              lifecyclePorts
            )
          )
        );

        assert.deepStrictEqual(outcome, {
          kind: "waits_only",
          workflowId: "wf_1",
        });
        assert.strictEqual(startForEntityMock.mock.calls.length, 0);
      })
    );

    it.effect("carries a first-wins refusal back as refused", () =>
      Effect.gen(function* () {
        startForEntityMock.mockReturnValue(
          Effect.succeed({
            status: "refused",
            inFlightExecutionIds: ["exec_running"],
          })
        );

        const outcome = yield* applyLifecycleRules({
          subscriber: subscriber(),
          event: appointmentCreated,
          payload,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubPublishedWorkflow(createWorkflow({ rules: startRules })),
              lifecyclePorts
            )
          )
        );

        assert.deepStrictEqual(outcome, {
          kind: "refused",
          workflowId: "wf_1",
          reason: "concurrency_first_wins",
        });
        assert.strictEqual(sendRunRequestedMock.mock.calls.length, 0);
      })
    );

    it.effect("routes the runs of an entity to the Canceled outlet", () =>
      Effect.gen(function* () {
        const outcome = yield* applyLifecycleRules({
          subscriber: subscriber({ roles: ["cancel"] }),
          event: appointmentCanceled,
          payload,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubPublishedWorkflow(createWorkflow({ rules: cancelRules })),
              lifecyclePorts
            )
          )
        );

        assert.deepStrictEqual(outcome, {
          kind: "canceled",
          workflowId: "wf_1",
          canceledExecutionIds: ["exec_running"],
        });
        assert.deepStrictEqual(requestCancelForEntityMock.mock.calls[0]?.[0], {
          workflowId: "wf_1",
          entityValue: "appt_8813",
          runMode: "live",
          eventName: "app/appointment.canceled",
          payload,
        });
        assert.strictEqual(startForEntityMock.mock.calls.length, 0);
      })
    );

    // The Event names the entity its author had in mind, and this workflow may
    // track a different one. The builder's path rides the subscription row, so
    // the override is read without the delivery consulting the graph.
    it.effect(
      "cancels on the path the builder set rather than the declared one",
      () =>
        Effect.gen(function* () {
          yield* applyLifecycleRules({
            subscriber: subscriber({
              roles: ["cancel"],
              correlationPath: "patient.id",
            }),
            event: appointmentCanceled,
            payload: {
              appointment: { id: "appt_8813" },
              patient: { id: "pat_42" },
            },
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                stubPublishedWorkflow(createWorkflow({ rules: cancelRules })),
                lifecyclePorts
              )
            )
          );

          assert.strictEqual(
            requestCancelForEntityMock.mock.calls[0]?.[0].entityValue,
            "pat_42"
          );
        })
    );

    // A cancel matches by Entity Value and has nothing else to match on, so a
    // payload carrying none reaches no run at all. The row is what a Refused
    // Start gets, and for the same reason: without it the builder watches the
    // runs carry on with nothing anywhere saying the cancel was refused.
    it.effect("refuses a cancel whose payload carries no Entity Value", () =>
      Effect.gen(function* () {
        const recorded: unknown[] = [];

        const outcome = yield* applyLifecycleRules({
          subscriber: subscriber({ roles: ["cancel"] }),
          event: appointmentCanceled,
          payload: { appointment: {} },
          deliveryId: "evt_arrival",
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubPublishedWorkflow(createWorkflow({ rules: cancelRules })),
              stubExecutionRepo({
                recordAuditEvent: (input) =>
                  Effect.sync(() => {
                    recorded.push(input);
                  }),
              }),
              stubInngestClient(),
              stubIntegrationRepo()
            )
          )
        );

        assert.deepStrictEqual(outcome, {
          kind: "refused",
          workflowId: "wf_1",
          reason: "entity_value_missing",
        });
        assert.strictEqual(requestCancelForEntityMock.mock.calls.length, 0);
        assert.deepStrictEqual(recorded, [
          {
            workflowId: "wf_1",
            eventType: "cancel_not_delivered",
            message:
              "Cancel from app/appointment.canceled reached no run: nothing at this workflow's Correlation Path",
            metadata: {
              reason: "entity_value_missing",
              eventName: "app/appointment.canceled",
              correlationPath: "appointment.id",
              deliveryId: "evt_arrival",
              runMode: "live",
            },
          },
        ]);
      })
    );

    // The role is the graph's, and the rules read here are what it is held to: a
    // workflow that has since dropped the Event from `cancelEvents` cancels
    // nothing on it.
    it.effect("cancels nothing where the rules no longer say to", () =>
      Effect.gen(function* () {
        const outcome = yield* applyLifecycleRules({
          subscriber: subscriber({ roles: ["cancel"] }),
          event: appointmentCanceled,
          payload,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubPublishedWorkflow(createWorkflow({ rules: startRules })),
              lifecyclePorts
            )
          )
        );

        assert.deepStrictEqual(outcome, {
          kind: "waits_only",
          workflowId: "wf_1",
        });
        assert.strictEqual(requestCancelForEntityMock.mock.calls.length, 0);
      })
    );

    // A delete landing between the index read and here. The rows cascade with the
    // workflow, so there is nothing to clean and nothing to deliver.
    it.effect("skips a workflow that is gone", () =>
      Effect.gen(function* () {
        const outcome = yield* applyLifecycleRules({
          subscriber: subscriber(),
          event: appointmentCreated,
          payload,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubWorkflowRepo({
                findByIdWithPublishedVersionForRun: () => Effect.succeed(null),
              }),
              lifecyclePorts
            )
          )
        );

        assert.deepStrictEqual(outcome, {
          kind: "skipped",
          workflowId: "wf_1",
          reason: "workflow_gone",
        });
      })
    );

    it.effect("skips a workflow whose graph will not run", () =>
      Effect.gen(function* () {
        const outcome = yield* applyLifecycleRules({
          subscriber: subscriber(),
          event: appointmentCreated,
          payload,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubPublishedWorkflow(
                createWorkflow({
                  graph: createSerializedWorkflowGraph({
                    nodes: [
                      {
                        id: "lifecycle-1",
                        type: "lifecycle",
                        position: { x: 0, y: 0 },
                        data: {
                          label: "Start",
                          type: "lifecycle",
                          config: { lifecycleRules: startRules },
                        },
                      },
                      {
                        id: "action-1",
                        type: "action",
                        position: { x: 0, y: 120 },
                        data: {
                          label: "Unset",
                          type: "action",
                          config: {},
                        },
                      },
                    ],
                    edges: [
                      {
                        id: "e1",
                        source: "lifecycle-1",
                        target: "action-1",
                        sourceHandle: LIFECYCLE_STARTED_HANDLE,
                      },
                    ],
                  }),
                })
              ),
              lifecyclePorts
            )
          )
        );

        assert.deepStrictEqual(outcome, {
          kind: "skipped",
          workflowId: "wf_1",
          reason: "graph_unrunnable",
        });
      })
    );

    // A rejected query is not a verdict: it keeps failing so the delivery is
    // retried rather than silently dropped.
    it.effect("leaves a refused query failing", () =>
      Effect.gen(function* () {
        const failure = yield* applyLifecycleRules({
          subscriber: subscriber(),
          event: appointmentCreated,
          payload,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubWorkflowRepo({
                findByIdWithPublishedVersionForRun: () =>
                  Effect.fail(
                    new DatabaseError({
                      cause: new Error("terminating connection due to crash"),
                    })
                  ),
              }),
              lifecyclePorts
            )
          ),
          Effect.flip
        );

        assert.instanceOf(failure, DatabaseError);
      })
    );
  });
});

describe("deliverToWaits", () => {
  layer(Layer.mergeAll(SilentAppLoggerLayer, catalogLayer, waitPorts))((it) => {
    // Candidates are found by Event name, and each row's own compiled match
    // decides. Nothing here reads a Correlation Path, which is what lets a run
    // park on an Event that has no entity of its own.
    it.effect("offers the Event to the runs parked on its name", () =>
      Effect.gen(function* () {
        listWaitsForEventMock.mockReturnValueOnce(
          Effect.succeed([parkedWait("app/appointment.created")])
        );

        const outcome = yield* deliverToWaits({
          subscriber: subscriber({ roles: ["wait"] }),
          event: appointmentCreated,
          payload,
          excluding: [],
        }).pipe(Effect.provide(stubWorkflowRepo()));

        assert.deepStrictEqual(outcome, {
          workflowId: "wf_1",
          resumedWaits: 1,
        });
        assert.deepStrictEqual(listWaitsForEventMock.mock.calls[0], [
          {
            workflowId: "wf_1",
            eventName: "app/appointment.created",
            runMode: "live",
            limit: 200,
            afterId: undefined,
            excludingExecutionIds: [],
          },
        ]);
        assert.strictEqual(sendWaitSignalMock.mock.calls.length, 1);
        assert.strictEqual(
          sendWaitSignalMock.mock.calls[0]?.[0].executionId,
          "exec_parked"
        );
      })
    );

    // A run this delivery settled takes nothing: one is ending, and the other has
    // parked nothing yet. The set goes to the query rather than to a filter after
    // it, so a settled run never occupies a place in the page.
    it.effect("leaves out the runs the lifecycle just settled", () =>
      Effect.gen(function* () {
        listWaitsForEventMock.mockReturnValueOnce(Effect.succeed([]));

        const outcome = yield* deliverToWaits({
          subscriber: subscriber(),
          event: appointmentCreated,
          payload,
          excluding: ["exec_superseded"],
        }).pipe(Effect.provide(stubWorkflowRepo()));

        assert.strictEqual(outcome.resumedWaits, 0);
        assert.strictEqual(sendWaitSignalMock.mock.calls.length, 0);
        assert.deepStrictEqual(
          listWaitsForEventMock.mock.calls[0][0].excludingExecutionIds,
          ["exec_superseded"]
        );
      })
    );

    // The failure this replaces: an Event nobody declared a path for reached no
    // parked run at all, whatever the Wait node had asked for.
    it.effect("reaches parked runs with no Correlation Path in sight", () =>
      Effect.gen(function* () {
        listWaitsForEventMock.mockReturnValueOnce(
          Effect.succeed([parkedWait("ops/nightly.swept")])
        );

        const outcome = yield* deliverToWaits({
          subscriber: subscriber({ roles: ["wait"] }),
          event: { name: "ops/nightly.swept" },
          payload: { sweep: { id: "sweep_1" } },
          excluding: [],
        }).pipe(Effect.provide(stubWorkflowRepo({})));

        assert.strictEqual(outcome.resumedWaits, 1);
        assert.deepStrictEqual(listWaitsForEventMock.mock.calls[0], [
          {
            workflowId: "wf_1",
            eventName: "ops/nightly.swept",
            runMode: "live",
            limit: 200,
            afterId: undefined,
            excludingExecutionIds: [],
          },
        ]);
        assert.strictEqual(sendWaitSignalMock.mock.calls.length, 1);
      })
    );

    // The wait half reads no graph: that column runs to megabytes and this path
    // runs per delivery.
    it.effect("reads no graph on the way to a parked run", () =>
      Effect.gen(function* () {
        const findById = vi.fn(() => Effect.succeed(null));
        listWaitsForEventMock.mockReturnValueOnce(Effect.succeed([]));

        yield* deliverToWaits({
          subscriber: subscriber({ roles: ["wait"] }),
          event: appointmentCreated,
          payload,
          excluding: [],
        }).pipe(Effect.provide(stubWorkflowRepo({ findById })));

        assert.strictEqual(findById.mock.calls.length, 0);
      })
    );

    it.effect("wakes nothing when no run is parked on the Event", () =>
      Effect.gen(function* () {
        listWaitsForEventMock.mockReturnValueOnce(Effect.succeed([]));

        const outcome = yield* deliverToWaits({
          subscriber: subscriber({ roles: ["wait"] }),
          event: { name: "ops/nightly.swept" },
          payload: { sweep: { id: "sweep_1" } },
          excluding: [],
        }).pipe(Effect.provide(stubWorkflowRepo({})));

        assert.strictEqual(outcome.resumedWaits, 0);
        assert.strictEqual(sendWaitSignalMock.mock.calls.length, 0);
      })
    );
  });
});
