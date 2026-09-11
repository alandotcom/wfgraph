import { assert, describe, layer } from "@effect/vitest";
// The mocks API has to be the one vitest itself exports; reaching it through the
// `@effect/vitest` re-export leaves it unable to find the module registry.
import { beforeEach, vi } from "vitest";
import { Cause, Effect, Fiber, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import type {
  PublishedWorkflowVersion,
  Workflow,
} from "#src/backend/lib/db/schema";
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
import type { EntityEligibilityReason } from "@wfgraph/shared/lifecycle/execution-contracts";
import type {
  EventSubscriber,
  WorkflowRepo,
} from "#src/backend/services/workflows/repo";
import { applyLifecycleRules } from "#src/backend/services/workflows/lifecycle/deliver-event";

/**
 * What a Start Filter does to an arrival, at the one seam that decides it.
 *
 * Separate from `deliver-event.test.ts` because the question is separate: that
 * file asks what the Lifecycle Rules do with an Event, and these cases ask what
 * happens between the start role being confirmed and Concurrency being consulted
 * (ADR-0016). The harness below is only what these cases need.
 */

type Repo = ExecutionRepo["Service"];

const startForEntityMock = vi.fn<Repo["startForEntity"]>();
const requestCancelForEntityMock = vi.fn<Repo["requestCancelForEntity"]>();
const findAdmissionRefusalMock = vi.fn<Repo["findAdmissionRefusal"]>();
const recordAdmissionRefusalMock = vi.fn<Repo["recordAdmissionRefusal"]>();
const findByDeliveryMock = vi.fn<Repo["findByDelivery"]>();
const findVersionByIdMock = vi.fn<WorkflowRepo["Service"]["findVersionById"]>();
const recordAuditEventMock = vi.fn<Repo["recordAuditEvent"]>(() => Effect.void);
const sendRunRequestedMock = vi.fn<
  InngestClient["Service"]["sendRunRequested"]
>(() => Effect.succeed({ eventId: "evt_1" }));
const sendCancelRequestedMock = vi.fn<
  InngestClient["Service"]["sendCancelRequested"]
>(() => Effect.void);
const settle = Effect.promise(
  () => new Promise<void>((resolve) => setImmediate(resolve))
);

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

/** One finished rule over `path`, as the Lifecycle panel would serialize it. */
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
    workflowRunId: null,
    deliveryId: null,
    enqueuedAt: null,
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
  };
}

const startedOutcome: EntityStartOutcome = {
  status: "started",
  execution: createExecution(),
  supersededExecutionIds: [],
  reclaimedExecutionIds: [],
};

/**
 * The Execution an earlier attempt of a delivery committed. `enqueuedAt` is
 * null when that attempt died before the send.
 */
function winnerExecution(input: {
  deliveryId: string;
  enqueuedAt: Date | null;
}): WorkflowExecution {
  return {
    ...createExecution(),
    id: "exec_winner",
    deliveryId: input.deliveryId,
    enqueuedAt: input.enqueuedAt,
    workflowRunId: input.enqueuedAt ? "evt_winner" : null,
    entityValue: null,
    entityType: "appointment",
    entityId: "appt_8813",
  };
}

/**
 * What `startForEntity` answers a replayed delivery with: the Execution an
 * earlier attempt of that delivery committed, and nothing displaced.
 */
function winnerOutcome(input: {
  deliveryId: string;
  enqueuedAt: Date | null;
}): EntityStartOutcome {
  return {
    status: "started",
    execution: winnerExecution(input),
    supersededExecutionIds: [],
    reclaimedExecutionIds: [],
  };
}

/** The entry node, carrying the rules under test and nothing else. */
function createWorkflow(input: { rules: LifecycleRules }): Workflow {
  return {
    id: "wf_1",
    name: "Appointment Reminders",
    description: null,
    graph: createSerializedWorkflowGraph({
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
    startForEntity: startForEntityMock,
    requestCancelForEntity: requestCancelForEntityMock,
    findAdmissionRefusal: findAdmissionRefusalMock,
    recordAdmissionRefusal: recordAdmissionRefusalMock,
    findByDelivery: findByDeliveryMock,
    recordAuditEvent: recordAuditEventMock,
    listWaitingStatesForExecutions: () => Effect.succeed(new Map()),
    markEnqueued: () => Effect.void,
  }),
  stubInngestClient({
    sendRunRequested: sendRunRequestedMock,
    sendCancelRequested: sendCancelRequestedMock,
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
  startForEntityMock.mockReset();
  requestCancelForEntityMock.mockReset();
  findAdmissionRefusalMock.mockReset();
  recordAdmissionRefusalMock.mockReset();
  findByDeliveryMock.mockReset();
  findVersionByIdMock.mockReset();
  recordAuditEventMock.mockReset();
  sendRunRequestedMock.mockReset();
  sendCancelRequestedMock.mockReset();
  resolveEntityMock.mockReset();
  selectEntityIdMock.mockClear();
  selectCanceledEntityIdMock.mockClear();

  resolveEntityMock.mockResolvedValue({
    status: "scheduled",
    remindersEnabled: true,
  });
  startForEntityMock.mockImplementation(() => Effect.succeed(startedOutcome));
  requestCancelForEntityMock.mockImplementation(() => Effect.succeed([]));
  findAdmissionRefusalMock.mockImplementation(() => Effect.succeed(null));
  recordAdmissionRefusalMock.mockImplementation((input) =>
    Effect.succeed({ kind: "refused", reason: input.reason })
  );
  findByDeliveryMock.mockImplementation(() => Effect.succeed(null));
  findVersionByIdMock.mockImplementation(() =>
    Effect.succeed(publishedVersion(createWorkflow({ rules: startRules })))
  );
  recordAuditEventMock.mockImplementation(() => Effect.void);
  sendRunRequestedMock.mockImplementation(() =>
    Effect.succeed({ eventId: "evt_1" })
  );
  sendCancelRequestedMock.mockImplementation(() => Effect.void);
});

describe("applyLifecycleRules and Start Filters", () => {
  layer(Layer.merge(SilentAppLoggerLayer, catalogLayer))((it) => {
    it.effect("starts when the arrival satisfies the Start Filter", () =>
      Effect.gen(function* () {
        const outcome = yield* applyLifecycleRules({
          subscriber: subscriber(),
          event: appointmentCreated,
          payload: videoPayload,
        }).pipe(
          Effect.provide(
            workflowWith(
              filteredRules(
                filterOn({
                  path: "appointment.channel",
                  fieldType: "string",
                  operator: "equals",
                  value: "video",
                })
              )
            )
          )
        );

        assert.strictEqual(outcome.kind, "started");
      })
    );

    it.effect("opens no run when the arrival fails the Start Filter", () =>
      Effect.gen(function* () {
        const outcome = yield* applyLifecycleRules({
          subscriber: subscriber(),
          event: appointmentCreated,
          payload: videoPayload,
          deliveryId: "evt_arrival",
        }).pipe(
          Effect.provide(
            workflowWith(
              filteredRules(
                filterOn({
                  path: "appointment.channel",
                  fieldType: "string",
                  operator: "equals",
                  value: "in_person",
                })
              )
            )
          )
        );

        assert.deepStrictEqual(outcome, {
          kind: "refused",
          workflowId: "wf_1",
          reason: "start_filter_not_met",
        });
        assert.strictEqual(startForEntityMock.mock.calls.length, 0);
      })
    );

    // A refusal nobody can read is the class of invisible behaviour ADR-0007
    // exists to remove, and the Refused Starts panel reads this row.
    it.effect("records the refusal against the workflow", () =>
      Effect.gen(function* () {
        yield* applyLifecycleRules({
          subscriber: subscriber(),
          event: appointmentCreated,
          payload: videoPayload,
          deliveryId: "evt_arrival",
        }).pipe(
          Effect.provide(
            workflowWith(
              filteredRules(
                filterOn({
                  path: "appointment.channel",
                  fieldType: "string",
                  operator: "equals",
                  value: "in_person",
                })
              )
            )
          )
        );

        const audit = recordAuditEventMock.mock.calls[0]?.[0];
        assert.strictEqual(audit?.eventType, "run_refused");
        assert.include(audit?.message ?? "", "start filter");
        assert.deepInclude(audit?.metadata, {
          reason: "start_filter_not_met",
          eventName: "app/appointment.created",
          deliveryId: "evt_arrival",
        });
      })
    );

    // The whole of why the filter is read here rather than by a Condition node
    // behind the Started outlet: by the time that node runs, the arrival has
    // already displaced the run that was in flight.
    it.effect(
      "leaves a newest-wins run in flight when the arrival fails the filter",
      () =>
        Effect.gen(function* () {
          const outcome = yield* applyLifecycleRules({
            subscriber: subscriber(),
            event: appointmentCreated,
            payload: videoPayload,
          }).pipe(
            Effect.provide(
              workflowWith(
                filteredRules(
                  filterOn({
                    path: "appointment.channel",
                    fieldType: "string",
                    operator: "equals",
                    value: "in_person",
                  }),
                  "newest-wins"
                )
              )
            )
          );

          assert.strictEqual(outcome.kind, "refused");
          // `startForEntity` is where a newest-wins start supersedes, so never
          // reaching it is the assertion: nothing was displaced.
          assert.strictEqual(startForEntityMock.mock.calls.length, 0);
          assert.strictEqual(sendCancelRequestedMock.mock.calls.length, 0);
        })
    );

    // The payload comes from outside and may carry anything, so a field of the
    // wrong type is an arrival the filter does not admit, not a reason to start.
    it.effect("opens no run when the Start Filter cannot be evaluated", () =>
      Effect.gen(function* () {
        const outcome = yield* applyLifecycleRules({
          subscriber: subscriber(),
          event: appointmentCreated,
          payload: videoPayload,
        }).pipe(
          Effect.provide(
            workflowWith(
              filteredRules(
                filterOn({
                  path: "appointment.seats",
                  fieldType: "number",
                  operator: "greater_than",
                  value: 1,
                })
              )
            )
          )
        );

        assert.deepStrictEqual(outcome, {
          kind: "refused",
          workflowId: "wf_1",
          reason: "start_filter_unevaluable",
        });
        assert.strictEqual(startForEntityMock.mock.calls.length, 0);
        assert.strictEqual(
          recordAuditEventMock.mock.calls[0]?.[0].eventType,
          "run_refused"
        );
      })
    );

    it.effect(
      "runs the Start Filter before selecting or resolving the tracked Entity",
      () =>
        Effect.gen(function* () {
          const outcome = yield* applyLifecycleRules({
            subscriber: subscriber(),
            event: appointmentCreated,
            payload: videoPayload,
          }).pipe(
            Effect.provide(
              workflowWith(
                guardedRules({
                  checkpoints: ["before-execution"],
                  startFilter: filterOn({
                    path: "appointment.channel",
                    fieldType: "string",
                    operator: "equals",
                    value: "in_person",
                  }),
                })
              )
            )
          );

          assert.strictEqual(outcome.kind, "refused");
          assert.strictEqual(selectEntityIdMock.mock.calls.length, 0);
          assert.strictEqual(resolveEntityMock.mock.calls.length, 0);
          assert.strictEqual(startForEntityMock.mock.calls.length, 0);
        })
    );

    it.effect(
      "refuses an ineligible Entity before Concurrency without persisting its state or id",
      () =>
        Effect.gen(function* () {
          resolveEntityMock.mockResolvedValue({
            status: "cancelled",
            remindersEnabled: false,
          });

          const outcome = yield* applyLifecycleRules({
            subscriber: subscriber(),
            event: appointmentCreated,
            payload: videoPayload,
            deliveryId: "evt_entity_refusal",
          }).pipe(
            Effect.provide(
              workflowWith(guardedRules({ checkpoints: ["before-execution"] }))
            )
          );

          assert.deepStrictEqual(outcome, {
            kind: "refused",
            workflowId: "wf_1",
            reason: "entity_condition_not_met",
          });
          assert.strictEqual(resolveEntityMock.mock.calls.length, 1);
          assert.strictEqual(startForEntityMock.mock.calls.length, 0);
          const audit = recordAdmissionRefusalMock.mock.calls[0]?.[0];
          assert.deepInclude(audit?.metadata, {
            reason: "entity_condition_not_met",
            entityType: "appointment",
            checkpoint: "before-execution",
            deliveryId: "evt_entity_refusal",
          });
          assert.notProperty(audit?.metadata ?? {}, "entityId");
          assert.notProperty(audit?.metadata ?? {}, "state");
        })
    );

    it.effect(
      "replays a durable admission refusal without resolving again",
      () =>
        Effect.gen(function* () {
          let storedReason: EntityEligibilityReason | null = null;
          findAdmissionRefusalMock.mockImplementation(() =>
            Effect.succeed(storedReason)
          );
          recordAdmissionRefusalMock.mockImplementation((input) =>
            Effect.sync(() => {
              storedReason = input.reason;
              return { kind: "refused" as const, reason: input.reason };
            })
          );
          resolveEntityMock
            .mockResolvedValueOnce({
              status: "cancelled",
              remindersEnabled: false,
            })
            .mockResolvedValue({
              status: "scheduled",
              remindersEnabled: true,
            });
          const delivery = {
            subscriber: subscriber(),
            event: appointmentCreated,
            payload: videoPayload,
            deliveryId: "evt_replayed_refusal",
          };
          const services = workflowWith(
            guardedRules({ checkpoints: ["before-execution"] })
          );

          const first = yield* applyLifecycleRules(delivery).pipe(
            Effect.provide(services)
          );
          const replay = yield* applyLifecycleRules(delivery).pipe(
            Effect.provide(services)
          );

          assert.strictEqual(first.kind, "refused");
          assert.strictEqual(replay.kind, "refused");
          assert.strictEqual(resolveEntityMock.mock.calls.length, 1);
          assert.strictEqual(recordAdmissionRefusalMock.mock.calls.length, 1);
          assert.strictEqual(startForEntityMock.mock.calls.length, 0);
        })
    );

    // The bus drops a second send carrying the same `workflow-run-<executionId>`
    // id, so resending a winner that was already sent starts nothing new. The
    // replayed start through `startWithConcurrency` resends the same way.
    it.effect("returns the start that won a racing admission refusal", () =>
      Effect.gen(function* () {
        resolveEntityMock.mockResolvedValue({
          status: "cancelled",
          remindersEnabled: false,
        });
        recordAdmissionRefusalMock.mockImplementation(() =>
          Effect.succeed({ kind: "started", executionId: "exec_winner" })
        );
        startForEntityMock.mockImplementation(() =>
          Effect.succeed(
            winnerOutcome({
              deliveryId: "evt_racing_start",
              enqueuedAt: new Date("2026-03-01T00:00:01.000Z"),
            })
          )
        );

        const outcome = yield* applyLifecycleRules({
          subscriber: subscriber(),
          event: appointmentCreated,
          payload: videoPayload,
          deliveryId: "evt_racing_start",
        }).pipe(
          Effect.provide(
            workflowWith(guardedRules({ checkpoints: ["before-execution"] }))
          )
        );

        assert.deepStrictEqual(outcome, {
          kind: "started",
          workflowId: "wf_1",
          executionId: "exec_winner",
          supersededExecutionIds: [],
          failedToSupersede: [],
        });
        assert.deepStrictEqual(
          sendRunRequestedMock.mock.calls.map(([data]) => data),
          [{ executionId: "exec_winner" }]
        );
      })
    );

    // Another attempt of the same delivery found the Entity eligible and
    // committed the Execution after this attempt's `findByDelivery` read came
    // back empty. This attempt reads the Entity as ineligible, and the delivery
    // still has to reach the bus, or the row stays in flight with no run.
    it.effect(
      "sends the Execution a concurrent attempt committed when this attempt finds the Entity ineligible",
      () =>
        Effect.gen(function* () {
          resolveEntityMock.mockResolvedValue({
            status: "cancelled",
            remindersEnabled: false,
          });
          recordAdmissionRefusalMock.mockImplementation(() =>
            Effect.succeed({ kind: "started", executionId: "exec_winner" })
          );
          startForEntityMock.mockImplementation(() =>
            Effect.succeed(
              winnerOutcome({ deliveryId: "evt_crashed", enqueuedAt: null })
            )
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

          assert.deepStrictEqual(outcome, {
            kind: "started",
            workflowId: "wf_1",
            executionId: "exec_winner",
            supersededExecutionIds: [],
            failedToSupersede: [],
          });
          assert.strictEqual(startForEntityMock.mock.calls.length, 1);
          assert.deepInclude(startForEntityMock.mock.calls[0]?.[0].execution, {
            deliveryId: "evt_crashed",
            entityType: "appointment",
            entityId: "appt_8813",
          });
          assert.deepStrictEqual(
            sendRunRequestedMock.mock.calls.map(([data]) => data),
            [{ executionId: "exec_winner" }]
          );
        })
    );

    // An earlier attempt committed the Execution and the step died before the
    // send. On retry the host resolver fails, and the delivery still has to
    // reach the bus. The committed row is read before selection and the
    // resolver, so neither runs.
    it.effect(
      "sends the Execution an earlier attempt committed without selecting or resolving the Entity again",
      () =>
        Effect.gen(function* () {
          resolveEntityMock.mockRejectedValue(new Error("host unavailable"));
          findByDeliveryMock.mockImplementation(() =>
            Effect.succeed(
              winnerExecution({ deliveryId: "evt_crashed", enqueuedAt: null })
            )
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

          assert.deepStrictEqual(outcome, {
            kind: "started",
            workflowId: "wf_1",
            executionId: "exec_winner",
            supersededExecutionIds: [],
            failedToSupersede: [],
          });
          assert.deepStrictEqual(findByDeliveryMock.mock.calls, [
            [{ workflowId: "wf_1", deliveryId: "evt_crashed" }],
          ]);
          assert.strictEqual(selectEntityIdMock.mock.calls.length, 0);
          assert.strictEqual(resolveEntityMock.mock.calls.length, 0);
          assert.strictEqual(startForEntityMock.mock.calls.length, 0);
          assert.strictEqual(recordAdmissionRefusalMock.mock.calls.length, 0);
          assert.deepStrictEqual(
            sendRunRequestedMock.mock.calls.map(([data]) => data),
            [{ executionId: "exec_winner" }]
          );
          const started = recordAuditEventMock.mock.calls.find(
            ([event]) => event.eventType === "run_started"
          )?.[0];
          assert.deepInclude(started?.metadata, {
            entityType: "appointment",
            deliveryId: "evt_crashed",
          });
        })
    );

    // The committed row pins the version the first attempt ran, and a Publish
    // between the two attempts moves the workflow on. The timeline entry has to
    // name the graph the run is executing, which is the pinned one.
    it.effect(
      "names the version the committed Execution pinned, not the one published now",
      () =>
        Effect.gen(function* () {
          const workflow = createWorkflow({
            rules: guardedRules({ checkpoints: ["before-execution"] }),
          });
          const pinned = publishedVersion(workflow);
          const republished: PublishedWorkflowVersion = {
            ...pinned,
            id: "ver_2",
            version: 2,
          };
          findByDeliveryMock.mockImplementation(() =>
            Effect.succeed(
              winnerExecution({ deliveryId: "evt_crashed", enqueuedAt: null })
            )
          );
          findVersionByIdMock.mockImplementation(() => Effect.succeed(pinned));

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
                    Effect.succeed({
                      workflow,
                      publishedVersion: republished,
                    }),
                  findPublishedVersion: () => Effect.succeed(republished),
                  findVersionById: findVersionByIdMock,
                }),
                lifecyclePorts
              )
            )
          );

          assert.strictEqual(outcome.kind, "started");
          assert.deepStrictEqual(findVersionByIdMock.mock.calls, [["ver_1"]]);
          const started = recordAuditEventMock.mock.calls.find(
            ([event]) => event.eventType === "run_started"
          )?.[0];
          assert.include(started?.message ?? "", "run of v1 started");
          assert.deepInclude(started?.metadata, { versionNumber: 1 });
          assert.deepStrictEqual(
            sendRunRequestedMock.mock.calls.map(([data]) => data),
            [{ executionId: "exec_winner" }]
          );
        })
    );

    it.effect("distinguishes a missing Entity from an ineligible one", () =>
      Effect.gen(function* () {
        resolveEntityMock.mockResolvedValue(null);

        const outcome = yield* applyLifecycleRules({
          subscriber: subscriber(),
          event: appointmentCreated,
          payload: videoPayload,
        }).pipe(
          Effect.provide(
            workflowWith(guardedRules({ checkpoints: ["before-execution"] }))
          )
        );

        assert.strictEqual(outcome.kind, "refused");
        if (outcome.kind === "refused") {
          assert.strictEqual(outcome.reason, "entity_not_found");
        }
        assert.strictEqual(startForEntityMock.mock.calls.length, 0);
      })
    );

    it.effect(
      "persists typed identity and skips the resolver for a node-only guard",
      () =>
        Effect.gen(function* () {
          const outcome = yield* applyLifecycleRules({
            subscriber: subscriber(),
            event: appointmentCreated,
            payload: videoPayload,
          }).pipe(
            Effect.provide(
              workflowWith(guardedRules({ checkpoints: ["before-node"] }))
            )
          );

          assert.strictEqual(outcome.kind, "started");
          assert.strictEqual(resolveEntityMock.mock.calls.length, 0);
          assert.deepInclude(startForEntityMock.mock.calls[0]?.[0].execution, {
            entityType: "appointment",
            entityId: "appt_8813",
          });
          assert.notProperty(
            startForEntityMock.mock.calls[0]?.[0].execution ?? {},
            "entityValue"
          );
        })
    );

    it.effect(
      "accepts a validated undefined value when the Event selector supports it",
      () =>
        Effect.gen(function* () {
          const selectUndefined = vi.fn((value: unknown) => {
            assert.strictEqual(value, undefined);
            return "appt_constant";
          });
          const outcome = yield* applyLifecycleRules({
            subscriber: subscriber(),
            event: {
              name: appointmentCreated.name,
              entityBindings: {
                appointment: {
                  entity: appointmentEntity,
                  selectEntityId: selectUndefined,
                },
              },
              validatedPayload: undefined,
            },
            payload: videoPayload,
          }).pipe(
            Effect.provide(
              workflowWith(guardedRules({ checkpoints: ["before-node"] }))
            )
          );

          assert.strictEqual(outcome.kind, "started");
          assert.strictEqual(selectUndefined.mock.calls.length, 1);
          assert.strictEqual(
            startForEntityMock.mock.calls[0]?.[0].execution.entityId,
            "appt_constant"
          );
        })
    );

    it.effect(
      "starts with typed identity only after admission Eligibility passes",
      () =>
        Effect.gen(function* () {
          const outcome = yield* applyLifecycleRules({
            subscriber: subscriber(),
            event: appointmentCreated,
            payload: videoPayload,
          }).pipe(
            Effect.provide(
              workflowWith(guardedRules({ checkpoints: ["before-execution"] }))
            )
          );

          assert.strictEqual(outcome.kind, "started");
          assert.strictEqual(resolveEntityMock.mock.calls.length, 1);
          assert.deepInclude(startForEntityMock.mock.calls[0]?.[0].execution, {
            entityType: "appointment",
            entityId: "appt_8813",
          });
        })
    );

    it.effect(
      "leaves a resolver failure operational and opens no Execution",
      () =>
        Effect.gen(function* () {
          resolveEntityMock.mockRejectedValue(new Error("host unavailable"));

          const exit = yield* Effect.exit(
            applyLifecycleRules({
              subscriber: subscriber(),
              event: appointmentCreated,
              payload: videoPayload,
            }).pipe(
              Effect.provide(
                workflowWith(
                  guardedRules({ checkpoints: ["before-execution"] })
                )
              )
            )
          );

          assert.strictEqual(exit._tag, "Failure");
          assert.strictEqual(startForEntityMock.mock.calls.length, 0);
          assert.strictEqual(recordAuditEventMock.mock.calls.length, 0);
        })
    );

    // `is_not_set` on a field the State schema no longer declares evaluates true
    // against any state, so evaluating it would admit the run.
    it.effect(
      "fails admission on a stored rule the current State schema refuses, without resolving",
      () =>
        Effect.gen(function* () {
          const rules = guardedRules({ checkpoints: ["before-execution"] });
          const guardedOnRemovedField = serializeConditionModel({
            version: 2,
            groupLogic: "and",
            groups: [
              {
                id: "group",
                logic: "and",
                conditions: [
                  {
                    id: "archived",
                    field: "archivedAt",
                    fieldType: "string",
                    operator: "is_not_set",
                  },
                ],
              },
            ],
          });

          const exit = yield* Effect.exit(
            applyLifecycleRules({
              subscriber: subscriber(),
              event: appointmentCreated,
              payload: videoPayload,
            }).pipe(
              Effect.provide(
                workflowWith({
                  ...rules,
                  entityEligibility: {
                    condition: guardedOnRemovedField,
                    checkpoints: ["before-execution"],
                  },
                })
              )
            )
          );

          assert.strictEqual(exit._tag, "Failure");
          if (exit._tag === "Failure") {
            const failure = Option.getOrUndefined(
              Cause.findErrorOption(exit.cause)
            );
            assert.include(
              String(failure?.cause),
              'reads "archivedAt", which Entity "appointment" does not declare'
            );
          }
          assert.strictEqual(resolveEntityMock.mock.calls.length, 0);
          assert.strictEqual(startForEntityMock.mock.calls.length, 0);
          assert.strictEqual(recordAdmissionRefusalMock.mock.calls.length, 0);
          assert.strictEqual(recordAuditEventMock.mock.calls.length, 0);
        })
    );

    it.effect(
      "times out an admission resolver without opening or refusing an Execution",
      () =>
        Effect.gen(function* () {
          resolveEntityMock.mockImplementation(
            () =>
              new Promise<{ status: string; remindersEnabled: boolean } | null>(
                () => undefined
              )
          );

          const fiber = yield* Effect.forkChild(
            Effect.exit(
              applyLifecycleRules({
                subscriber: subscriber(),
                event: appointmentCreated,
                payload: videoPayload,
              }).pipe(
                Effect.provide(
                  workflowWith(
                    guardedRules({ checkpoints: ["before-execution"] })
                  )
                )
              )
            )
          );
          yield* settle;
          yield* TestClock.adjust("10 seconds");

          const exit = yield* Fiber.join(fiber);
          assert.strictEqual(exit._tag, "Failure");
          assert.strictEqual(startForEntityMock.mock.calls.length, 0);
          assert.strictEqual(recordAuditEventMock.mock.calls.length, 0);
          assert.strictEqual(recordAdmissionRefusalMock.mock.calls.length, 0);
        })
    );

    it.effect("matches guarded cancellations by typed Entity identity", () =>
      Effect.gen(function* () {
        const outcome = yield* applyLifecycleRules({
          subscriber: { ...subscriber(), roles: ["cancel"] },
          event: appointmentCanceled,
          payload: { appointmentId: "appt_8813", reason: "host request" },
        }).pipe(Effect.provide(workflowWith(guardedCancelRules())));

        assert.strictEqual(outcome.kind, "canceled");
        assert.deepInclude(requestCancelForEntityMock.mock.calls[0]?.[0], {
          workflowId: "wf_1",
          entityType: "appointment",
          entityId: "appt_8813",
        });
        assert.notProperty(
          requestCancelForEntityMock.mock.calls[0]?.[0] ?? {},
          "entityValue"
        );
      })
    );

    it.effect("runs a guarded Cancel Filter before its Entity selector", () =>
      Effect.gen(function* () {
        const outcome = yield* applyLifecycleRules({
          subscriber: { ...subscriber(), roles: ["cancel"] },
          event: appointmentCanceled,
          payload: { appointmentId: "appt_8813", reason: "host request" },
        }).pipe(
          Effect.provide(
            workflowWith(
              guardedCancelRules(
                filterOn({
                  path: "reason",
                  fieldType: "string",
                  operator: "equals",
                  value: "duplicate",
                })
              )
            )
          )
        );

        assert.strictEqual(outcome.kind, "refused");
        assert.strictEqual(selectCanceledEntityIdMock.mock.calls.length, 0);
        assert.strictEqual(requestCancelForEntityMock.mock.calls.length, 0);
      })
    );

    it.effect(
      "leaves an Event with no Start Filter starting every arrival",
      () =>
        Effect.gen(function* () {
          const outcome = yield* applyLifecycleRules({
            subscriber: subscriber(),
            event: appointmentCreated,
            payload: videoPayload,
          }).pipe(Effect.provide(workflowWith(startRules)));

          assert.strictEqual(outcome.kind, "started");
        })
    );
  });
});
