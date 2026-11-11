import { assert, describe, layer } from "@effect/vitest";
// The mocks API has to be the one vitest itself exports; reaching it through the
// `@effect/vitest` re-export leaves it unable to find the module registry.
import { beforeEach, vi } from "vitest";
import { Effect, Layer, Schema } from "effect";
import type {
  PublishedWorkflowVersion,
  Workflow,
} from "#src/backend/lib/db/schema";
import {
  SilentAppLoggerLayer,
  stubExecutionDriver,
  stubExecutionRepo,
  stubExtensionCatalog,
  stubIntegrationRepo,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import type { ExecutionDriver } from "#src/backend/services/executions/driver";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { LIFECYCLE_STARTED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import { defineEntity } from "#src/backend/extensions/define-entity";
import { defineEvent } from "#src/backend/extensions/define-event";
import type { ConditionModel } from "@wfgraph/shared/conditions/conditions";
import { serializeConditionModel } from "@wfgraph/shared/conditions/conditions";
import type { LifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type {
  EntityStartOutcome,
  ExecutionRepo,
  WorkflowExecution,
} from "#src/backend/services/executions/repo";
import type {
  EventSubscriber,
  WorkflowRepo,
} from "#src/backend/services/workflows/repo";
import {
  applyLifecycleRules,
  type LifecycleDeliveryOutcome,
} from "#src/backend/services/workflows/lifecycle/deliver-event";

/**
 * What a retried delivery is answered with once an earlier attempt of it
 * committed a decision, at the one seam that reads that decision back.
 *
 * Separate from `deliver-event.start-filters.test.ts`, which asks what happens
 * after the start role is confirmed: these cases are decided ahead of that gate
 * and every other one. The harness below is only what they need.
 */

type Repo = ExecutionRepo["Service"];

type Driver = ExecutionDriver["Service"];

const startRunMock = vi.fn<Driver["startRun"]>();
const requestCanceledOutletMock = vi.fn<Driver["requestCanceledOutlet"]>();
const findAdmissionRefusalMock = vi.fn<Repo["findAdmissionRefusal"]>();
const recordAdmissionRefusalMock = vi.fn<Repo["recordAdmissionRefusal"]>();
const findByDeliveryMock = vi.fn<Repo["findByDelivery"]>();
const findVersionByIdMock = vi.fn<WorkflowRepo["Service"]["findVersionById"]>();
const recordAuditEventMock = vi.fn<Repo["recordAuditEvent"]>(() => Effect.void);
const resolveEntityMock = vi.fn(
  async (): Promise<{ status: string; remindersEnabled: boolean } | null> => ({
    status: "scheduled",
    remindersEnabled: true,
  })
);
const appointmentEntity = defineEntity({
  type: "appointment",
  label: "Appointment",
  state: Schema.Struct({
    status: Schema.String,
    remindersEnabled: Schema.Boolean,
  }),
  resolve: resolveEntityMock,
});
const selectEntityIdMock = vi.fn(
  (event: { appointment: { id: string } }) => event.appointment.id
);
const appointmentCreatedDefinition = defineEvent({
  name: "app/appointment.created",
  label: "Appointment created",
  schema: Schema.Struct({
    appointment: Schema.Struct({
      id: Schema.String,
      channel: Schema.String,
      seats: Schema.String,
    }),
  }),
  correlationPath: "appointment.id",
  entities: {
    appointment: {
      entity: appointmentEntity,
      selectEntityId: selectEntityIdMock,
    },
  },
});
const selectCanceledEntityIdMock = vi.fn(
  (event: { appointmentId: string; reason: string }) => event.appointmentId
);
const appointmentCanceledDefinition = defineEvent({
  name: "app/appointment.canceled",
  label: "Appointment canceled",
  schema: Schema.Struct({
    appointmentId: Schema.String,
    reason: Schema.String,
  }),
  entities: {
    appointment: {
      entity: appointmentEntity,
      selectEntityId: selectCanceledEntityIdMock,
    },
  },
});

const catalogLayer = stubExtensionCatalog({
  events: [
    {
      name: "app/appointment.created",
      label: "Appointment created",
      correlationPath: "appointment.id",
      payloadFields: [
        { path: "appointment.id", type: "string" },
        { path: "appointment.channel", type: "string" },
        { path: "appointment.seats", type: "number" },
      ],
      entityBindings: [{ name: "appointment", entityType: "appointment" }],
    },
    {
      name: "app/appointment.canceled",
      label: "Appointment canceled",
      payloadFields: [
        { path: "appointmentId", type: "string" },
        { path: "reason", type: "string" },
      ],
      entityBindings: [{ name: "appointment", entityType: "appointment" }],
    },
  ],
  entities: [
    {
      type: "appointment",
      label: "Appointment",
      stateFields: [
        { path: "status", type: "string" },
        { path: "remindersEnabled", type: "boolean" },
      ],
      stateSchemaDigest: appointmentEntity.stateSchemaDigest,
    },
  ],
});

const appointmentCreated = {
  name: appointmentCreatedDefinition.name,
  correlationPath: appointmentCreatedDefinition.correlationPath,
  entityBindings: appointmentCreatedDefinition.entities,
  validatedPayload: {
    appointment: { id: "appt_8813", channel: "video", seats: "two" },
  },
};
const appointmentCanceled = {
  name: appointmentCanceledDefinition.name,
  entityBindings: appointmentCanceledDefinition.entities,
  validatedPayload: {
    appointmentId: "appt_8813",
    reason: "host request",
  },
};

/** A payload the Start Filters below are written against. */
const videoPayload = {
  appointment: { id: "appt_8813", channel: "video", seats: "two" },
};

/** One finished rule over `path`, as the Lifecycle Node inspector would serialize it. */
function filterOn(input: {
  path: string;
  fieldType: "string" | "number";
  operator: string;
  value: string | number;
}): string {
  return serializeConditionModel({
    version: 2,
    groupLogic: "and",
    groups: [
      {
        id: "group",
        logic: "and",
        conditions: [
          {
            id: "rule",
            field: input.path,
            fieldType: input.fieldType,
            operator: input.operator,
            value: input.value,
          },
        ],
      },
    ] as ConditionModel["groups"],
  });
}

/** Start Rules whose one Start Event carries this filter. */
function filteredRules(
  filter: string,
  concurrency: LifecycleRules["concurrency"] = "unlimited"
): LifecycleRules {
  return {
    startEvents: ["app/appointment.created"],
    cancelEvents: [],
    concurrency,
    correlationPaths:
      concurrency === "unlimited"
        ? undefined
        : { "app/appointment.created": "appointment.id" },
    startFilters: { "app/appointment.created": filter },
  };
}

function guardedRules(input: {
  checkpoints: Array<"before-execution" | "before-node">;
  status?: string;
  startFilter?: string | undefined;
}): LifecycleRules {
  return {
    startEvents: ["app/appointment.created"],
    cancelEvents: [],
    concurrency: "newest-wins",
    startFilters: input.startFilter
      ? { "app/appointment.created": input.startFilter }
      : undefined,
    trackedEntity: {
      type: "appointment",
      bindings: { "app/appointment.created": "appointment" },
    },
    entityEligibility: {
      condition: filterOn({
        path: "status",
        fieldType: "string",
        operator: "equals",
        value: input.status ?? "scheduled",
      }),
      checkpoints: input.checkpoints,
    },
  };
}

function guardedCancelRules(cancelFilter?: string): LifecycleRules {
  return {
    startEvents: ["app/appointment.created"],
    cancelEvents: ["app/appointment.canceled"],
    concurrency: "newest-wins",
    cancelFilters: cancelFilter
      ? { "app/appointment.canceled": cancelFilter }
      : undefined,
    trackedEntity: {
      type: "appointment",
      bindings: {
        "app/appointment.created": "appointment",
        "app/appointment.canceled": "appointment",
      },
    },
    entityEligibility: {
      condition: filterOn({
        path: "status",
        fieldType: "string",
        operator: "equals",
        value: "scheduled",
      }),
      checkpoints: ["before-node"],
    },
  };
}

const startRules: LifecycleRules = {
  startEvents: ["app/appointment.created"],
  cancelEvents: [],
  concurrency: "unlimited",
};

function createExecution(): WorkflowExecution {
  return {
    id: "exec_new",
    workflowId: "wf_1",
    deliveryId: null,
    status: "running",
    startSource: "event",
    runMode: "live",
    startEventName: "app/appointment.created",
    entityValue: "appt_8813",
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
    scheduledFor: null,
    scheduleCron: null,
    scheduleTimeZone: null,
  };
}

const startedOutcome: EntityStartOutcome = {
  status: "started",
  execution: createExecution(),
  supersededExecutionIds: [],
};

/** The Execution an earlier attempt of a delivery committed. */
function winnerExecution(input: { deliveryId: string }): WorkflowExecution {
  return {
    ...createExecution(),
    id: "exec_winner",
    deliveryId: input.deliveryId,
    entityValue: null,
    entityType: "appointment",
    entityId: "appt_8813",
  };
}

/**
 * The entry node, carrying the rules under test and nothing else, unless the
 * case hands over a whole graph because what it asks about is the graph.
 */
function createWorkflow(input: {
  rules: LifecycleRules;
  graph?: Workflow["graph"] | undefined;
}): Workflow {
  return {
    id: "wf_1",
    name: "Appointment Reminders",
    description: null,
    graph:
      input.graph ??
      createSerializedWorkflowGraph({
        nodes: [
          {
            id: "lifecycle-1",
            type: "lifecycle",
            position: { x: 0, y: 0 },
            data: {
              label: "Start",
              type: "lifecycle",
              config: { lifecycleRules: input.rules },
            },
          },
        ],
        edges: [],
      }),
    draftRevision: 1,
    isPaused: false,
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
    lastPinnedAt: null,
  };
}

function stubPublishedWorkflow(workflow: Workflow) {
  return stubWorkflowRepo({
    findById: () => Effect.succeed(workflow),
    findByIdWithPublishedVersionForRun: () =>
      Effect.succeed({
        workflow,
        publishedVersion: publishedVersion(workflow),
      }),
    findPublishedVersion: () => Effect.succeed(publishedVersion(workflow)),
    // A recovered Execution names the version it pinned, which the timeline
    // entry reads the version number off.
    findVersionById: findVersionByIdMock,
  });
}

function subscriber(): EventSubscriber {
  return {
    id: "wf_1",
    roles: ["start"],
    correlationPath: null,
    connectionId: null,
  };
}

const lifecyclePorts = Layer.mergeAll(
  stubExecutionRepo({
    findAdmissionRefusal: findAdmissionRefusalMock,
    recordAdmissionRefusal: recordAdmissionRefusalMock,
    findByDelivery: findByDeliveryMock,
    recordAuditEvent: recordAuditEventMock,
  }),
  stubExecutionDriver({
    startRun: startRunMock,
    requestCanceledOutlet: requestCanceledOutletMock,
  }),
  stubIntegrationRepo()
);

/** The whole graph this delivery reads, as one layer per case. */
function workflowWith(rules: LifecycleRules) {
  return Layer.mergeAll(
    stubPublishedWorkflow(createWorkflow({ rules })),
    lifecyclePorts
  );
}

beforeEach(() => {
  startRunMock.mockReset();
  requestCanceledOutletMock.mockReset();
  findAdmissionRefusalMock.mockReset();
  recordAdmissionRefusalMock.mockReset();
  findByDeliveryMock.mockReset();
  findVersionByIdMock.mockReset();
  recordAuditEventMock.mockReset();
  resolveEntityMock.mockReset();
  selectEntityIdMock.mockClear();
  selectCanceledEntityIdMock.mockClear();

  resolveEntityMock.mockResolvedValue({
    status: "scheduled",
    remindersEnabled: true,
  });
  startRunMock.mockImplementation(() => Effect.succeed(startedOutcome));
  requestCanceledOutletMock.mockImplementation(() => Effect.succeed([]));
  findAdmissionRefusalMock.mockImplementation(() => Effect.succeed(null));
  recordAdmissionRefusalMock.mockImplementation((input) =>
    Effect.succeed({ kind: "refused", reason: input.reason })
  );
  findByDeliveryMock.mockImplementation(() => Effect.succeed(null));
  findVersionByIdMock.mockImplementation(() =>
    Effect.succeed(publishedVersion(createWorkflow({ rules: startRules })))
  );
  recordAuditEventMock.mockImplementation(() => Effect.void);
});

/**
 * What every case here has in common: the workflow changed between the first
 * attempt at this delivery and the retry, and the Execution the first attempt
 * committed is the answer. That attempt scheduled the run and wrote its "run
 * started" entry in the transaction that opened it, so the retry starts
 * nothing and writes nothing, whatever the workflow says now and whatever
 * status the row holds.
 */
describe("a delivery retried after its Execution was committed", () => {
  const committedOutcome: LifecycleDeliveryOutcome = {
    kind: "started",
    workflowId: "wf_1",
    executionId: "exec_winner",
    supersededExecutionIds: [],
  };

  /** Rules that name no Start Event at all, as an unpublish-and-republish left them. */
  const noStartEventRules: LifecycleRules = {
    startEvents: [],
    cancelEvents: [],
    concurrency: "unlimited",
  };

  function assertAnsweredFromTheCommittedRow() {
    assert.strictEqual(startRunMock.mock.calls.length, 0);
    assert.strictEqual(recordAdmissionRefusalMock.mock.calls.length, 0);
    assert.strictEqual(recordAuditEventMock.mock.calls.length, 0);
    assert.strictEqual(findVersionByIdMock.mock.calls.length, 0);
  }

  layer(Layer.merge(SilentAppLoggerLayer, catalogLayer))((it) => {
    it.effect(
      "answers with the committed Execution when the workflow has since been unpublished",
      () =>
        Effect.gen(function* () {
          const workflow = createWorkflow({
            rules: guardedRules({ checkpoints: ["before-execution"] }),
          });
          findByDeliveryMock.mockImplementation(() =>
            Effect.succeed(winnerExecution({ deliveryId: "evt_crashed" }))
          );

          const outcome = yield* applyLifecycleRules({
            subscriber: subscriber(),
            event: appointmentCreated,
            payload: videoPayload,
            deliveryId: "evt_crashed",
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                stubWorkflowRepo({
                  findById: () => Effect.succeed(workflow),
                  findByIdWithPublishedVersionForRun: () =>
                    Effect.succeed({ workflow, publishedVersion: null }),
                  findPublishedVersion: () => Effect.succeed(null),
                  findVersionById: findVersionByIdMock,
                }),
                lifecyclePorts
              )
            )
          );

          assert.deepStrictEqual(outcome, committedOutcome);
          assertAnsweredFromTheCommittedRow();
          // The published graph is where the Entity bindings are read from, and
          // there is no published graph here.
          assert.strictEqual(resolveEntityMock.mock.calls.length, 0);
        })
    );

    it.effect(
      "answers with the committed Execution when a republish dropped the Event from the Start Events",
      () =>
        Effect.gen(function* () {
          findByDeliveryMock.mockImplementation(() =>
            Effect.succeed(winnerExecution({ deliveryId: "evt_crashed" }))
          );

          const outcome = yield* applyLifecycleRules({
            subscriber: subscriber(),
            event: appointmentCreated,
            payload: videoPayload,
            deliveryId: "evt_crashed",
          }).pipe(Effect.provide(workflowWith(noStartEventRules)));

          assert.deepStrictEqual(outcome, committedOutcome);
          assertAnsweredFromTheCommittedRow();
        })
    );

    // An earlier attempt committed the Execution and the step died before it
    // recorded its answer. On retry the host resolver fails, and the delivery
    // still answers with the committed run. The committed row is read before
    // selection and the resolver, so neither runs.
    it.effect(
      "answers with the Execution an earlier attempt committed without selecting or resolving the Entity again",
      () =>
        Effect.gen(function* () {
          resolveEntityMock.mockRejectedValue(new Error("host unavailable"));
          findByDeliveryMock.mockImplementation(() =>
            Effect.succeed(winnerExecution({ deliveryId: "evt_crashed" }))
          );

          const outcome = yield* applyLifecycleRules({
            subscriber: subscriber(),
            event: appointmentCreated,
            payload: videoPayload,
            deliveryId: "evt_crashed",
          }).pipe(
            Effect.provide(
              workflowWith(guardedRules({ checkpoints: ["before-execution"] }))
            )
          );

          assert.deepStrictEqual(outcome, committedOutcome);
          assert.deepStrictEqual(findByDeliveryMock.mock.calls, [
            [{ workflowId: "wf_1", deliveryId: "evt_crashed" }],
          ]);
          assert.strictEqual(selectEntityIdMock.mock.calls.length, 0);
          assert.strictEqual(resolveEntityMock.mock.calls.length, 0);
          assertAnsweredFromTheCommittedRow();
        })
    );

    it.effect(
      "answers with the committed Execution when tracking was removed from the rules",
      () =>
        Effect.gen(function* () {
          findByDeliveryMock.mockImplementation(() =>
            Effect.succeed(winnerExecution({ deliveryId: "evt_crashed" }))
          );

          const outcome = yield* applyLifecycleRules({
            subscriber: subscriber(),
            event: appointmentCreated,
            payload: videoPayload,
            deliveryId: "evt_crashed",
          }).pipe(Effect.provide(workflowWith(startRules)));

          assert.deepStrictEqual(outcome, committedOutcome);
          assertAnsweredFromTheCommittedRow();
          // The row carries the typed identity Concurrency serialized it on, so
          // nothing selects it from the payload again.
          assert.strictEqual(selectEntityIdMock.mock.calls.length, 0);
        })
    );

    // The refusal read is not behind the rules either: a refusal recorded while
    // the workflow tracked an Entity still owns the delivery once tracking is
    // gone, and answering it twice would open a run the first attempt declined.
    it.effect(
      "answers a refusal an earlier attempt recorded although the rules no longer track an Entity",
      () =>
        Effect.gen(function* () {
          findAdmissionRefusalMock.mockImplementation(() =>
            Effect.succeed("entity_not_found")
          );

          const outcome = yield* applyLifecycleRules({
            subscriber: subscriber(),
            event: appointmentCreated,
            payload: videoPayload,
            deliveryId: "evt_crashed",
          }).pipe(Effect.provide(workflowWith(startRules)));

          assert.deepStrictEqual(outcome, {
            kind: "refused",
            workflowId: "wf_1",
            reason: "entity_not_found",
          });
          assert.strictEqual(findByDeliveryMock.mock.calls.length, 0);
          assert.strictEqual(startRunMock.mock.calls.length, 0);
        })
    );

    // A first-wins or Start Filter refusal is recorded under the same id as an
    // Entity refusal, so a delivery run again after its memo was lost, such as
    // a resent failed row, answers it instead of deciding the start again.
    it.effect(
      "answers a first-wins refusal an earlier attempt recorded without deciding the start again",
      () =>
        Effect.gen(function* () {
          findAdmissionRefusalMock.mockImplementation(() =>
            Effect.succeed("concurrency_first_wins")
          );

          const outcome = yield* applyLifecycleRules({
            subscriber: subscriber(),
            event: appointmentCreated,
            payload: videoPayload,
            deliveryId: "evt_reopened",
          }).pipe(Effect.provide(workflowWith(startRules)));

          assert.deepStrictEqual(outcome, {
            kind: "refused",
            workflowId: "wf_1",
            reason: "concurrency_first_wins",
          });
          assert.strictEqual(startRunMock.mock.calls.length, 0);
          assert.strictEqual(recordAuditEventMock.mock.calls.length, 0);
        })
    );

    // Preflight reads the graph published now, and the committed row pins the
    // graph it was opened against, which the run is executing regardless.
    it.effect(
      "answers with the committed Execution when the published graph no longer passes preflight",
      () =>
        Effect.gen(function* () {
          findByDeliveryMock.mockImplementation(() =>
            Effect.succeed(winnerExecution({ deliveryId: "evt_crashed" }))
          );

          const outcome = yield* applyLifecycleRules({
            subscriber: subscriber(),
            event: appointmentCreated,
            payload: videoPayload,
            deliveryId: "evt_crashed",
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                stubPublishedWorkflow(
                  createWorkflow({
                    rules: startRules,
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
                          data: { label: "Unset", type: "action", config: {} },
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

          assert.deepStrictEqual(outcome, committedOutcome);
          assertAnsweredFromTheCommittedRow();
        })
    );

    // The Start Filter decides which arrivals may open a run. This arrival
    // already opened one, so the filter has nothing left to decide and writing
    // a Refused Start row would contradict the run that is about to execute.
    it.effect(
      "answers with an untracked committed Execution although the Start Filter now refuses the payload",
      () =>
        Effect.gen(function* () {
          findByDeliveryMock.mockImplementation(() =>
            Effect.succeed({
              ...winnerExecution({
                deliveryId: "evt_crashed",
              }),
              entityValue: "appt_8813",
              entityType: null,
              entityId: null,
            })
          );

          const outcome = yield* applyLifecycleRules({
            subscriber: subscriber(),
            event: appointmentCreated,
            payload: videoPayload,
            deliveryId: "evt_crashed",
          }).pipe(
            Effect.provide(
              workflowWith(
                filteredRules(
                  filterOn({
                    path: "appointment.channel",
                    fieldType: "string",
                    operator: "equals",
                    value: "phone",
                  })
                )
              )
            )
          );

          assert.deepStrictEqual(outcome, committedOutcome);
          assertAnsweredFromTheCommittedRow();
          assert.strictEqual(
            recordAuditEventMock.mock.calls.filter(
              ([event]) => event.eventType === "run_refused"
            ).length,
            0
          );
        })
    );

    // The run the committed Execution opened has already reached a verdict. A
    // second "run started" entry would be filed after the entry that closed
    // the run.
    it.effect("answers with a committed row whose run has ended", () =>
      Effect.gen(function* () {
        findByDeliveryMock.mockImplementation(() =>
          Effect.succeed({
            ...winnerExecution({
              deliveryId: "evt_crashed",
            }),
            status: "completed",
          })
        );

        const outcome = yield* applyLifecycleRules({
          subscriber: subscriber(),
          event: appointmentCreated,
          payload: videoPayload,
          deliveryId: "evt_crashed",
        }).pipe(
          Effect.provide(
            workflowWith(guardedRules({ checkpoints: ["before-execution"] }))
          )
        );

        assert.deepStrictEqual(outcome, committedOutcome);
        assertAnsweredFromTheCommittedRow();
      })
    );

    // The earlier attempt scheduled the run, and the run is parked in a Wait,
    // so the retry has nothing to add to it.
    it.effect("answers with a committed row whose run is parked", () =>
      Effect.gen(function* () {
        findByDeliveryMock.mockImplementation(() =>
          Effect.succeed({
            ...winnerExecution({
              deliveryId: "evt_crashed",
            }),
            status: "waiting",
          })
        );

        const outcome = yield* applyLifecycleRules({
          subscriber: subscriber(),
          event: appointmentCreated,
          payload: videoPayload,
          deliveryId: "evt_crashed",
        }).pipe(
          Effect.provide(
            workflowWith(guardedRules({ checkpoints: ["before-execution"] }))
          )
        );

        assert.deepStrictEqual(outcome, committedOutcome);
        assertAnsweredFromTheCommittedRow();
      })
    );

    // A delivery that held the cancel role committed no start, so neither read
    // can find anything and both are skipped.
    it.effect("skips a cancel-role delivery's recovery reads", () =>
      Effect.gen(function* () {
        const outcome = yield* applyLifecycleRules({
          subscriber: { ...subscriber(), roles: ["cancel"] },
          event: appointmentCanceled,
          payload: { appointmentId: "appt_8813", reason: "host request" },
          deliveryId: "evt_cancel",
        }).pipe(Effect.provide(workflowWith(guardedCancelRules())));

        assert.strictEqual(outcome.kind, "canceled");
        assert.strictEqual(findAdmissionRefusalMock.mock.calls.length, 0);
        assert.strictEqual(findByDeliveryMock.mock.calls.length, 0);
      })
    );
  });
});
