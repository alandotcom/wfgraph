// The mocks API has to be the one vitest itself exports; reaching it through the
// `@effect/vitest` re-export leaves it unable to find the module registry.
import { vi } from "vitest";
import { Effect, Layer, Schema } from "effect";
import type {
  PublishedWorkflowVersion,
  Workflow,
} from "#src/backend/lib/db/schema";
import type { InngestClient } from "#src/backend/lib/effect/inngest-client";
import {
  stubExecutionRepo,
  stubExtensionCatalog,
  stubInngestClient,
  stubIntegrationRepo,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { defineEntity } from "#src/backend/extensions/define-entity";
import { defineEvent } from "#src/backend/extensions/define-event";
import type { ConditionRule } from "@wfgraph/shared/conditions/conditions";
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

/**
 * The Appointment fixture `deliver-event.start-filters.test.ts` and
 * `deliver-event.admission.test.ts` both drive `applyLifecycleRules` through:
 * one tracked Entity, its typed Start and Cancel Events, the mocked ports, and
 * the rule and outcome builders each case composes from. Call
 * `resetGuardedStartMocks` from each file's own `beforeEach`: under
 * `isolate: false` these `vi.fn` instances are the same objects in both files,
 * so a case in one file that skips the reset would read a call count the
 * other file's test left behind.
 */

type Repo = ExecutionRepo["Service"];

export const startForEntityMock = vi.fn<Repo["startForEntity"]>();
export const requestCancelForEntityMock =
  vi.fn<Repo["requestCancelForEntity"]>();
export const findAdmissionRefusalMock = vi.fn<Repo["findAdmissionRefusal"]>();
export const recordAdmissionRefusalMock =
  vi.fn<Repo["recordAdmissionRefusal"]>();
export const findByDeliveryMock = vi.fn<Repo["findByDelivery"]>();
export const findVersionByIdMock =
  vi.fn<WorkflowRepo["Service"]["findVersionById"]>();
export const recordAuditEventMock = vi.fn<Repo["recordAuditEvent"]>(
  () => Effect.void
);
export const sendRunRequestedMock = vi.fn<
  InngestClient["Service"]["sendRunRequested"]
>(() => Effect.succeed({ eventId: "evt_1" }));
export const sendCancelRequestedMock = vi.fn<
  InngestClient["Service"]["sendCancelRequested"]
>(() => Effect.void);

export const resolveEntityMock = vi.fn(
  async (): Promise<{ status: string; remindersEnabled: boolean } | null> => ({
    status: "scheduled",
    remindersEnabled: true,
  })
);
export const appointmentEntity = defineEntity({
  type: "appointment",
  label: "Appointment",
  state: Schema.Struct({
    status: Schema.String,
    remindersEnabled: Schema.Boolean,
  }),
  resolve: resolveEntityMock,
});
export const selectEntityIdMock = vi.fn(
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
export const selectCanceledEntityIdMock = vi.fn(
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

export const catalogLayer = stubExtensionCatalog({
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

export const appointmentCreated = {
  name: appointmentCreatedDefinition.name,
  correlationPath: appointmentCreatedDefinition.correlationPath,
  entityBindings: appointmentCreatedDefinition.entities,
  validatedPayload: {
    appointment: { id: "appt_8813", channel: "video", seats: "two" },
  },
};
export const appointmentCanceled = {
  name: appointmentCanceledDefinition.name,
  entityBindings: appointmentCanceledDefinition.entities,
  validatedPayload: {
    appointmentId: "appt_8813",
    reason: "host request",
  },
};

/** A payload the Start Filters below are written against. */
export const videoPayload = {
  appointment: { id: "appt_8813", channel: "video", seats: "two" },
};

// The operator each rule variant accepts, read off `ConditionRule` itself
// rather than named independently, so a fieldType this fixture builds can
// never drift from what the rule union actually allows for it. Matching on
// `value` as well as `fieldType` keeps `StringConditionRule`'s `values` (plural)
// variant out of the extraction: this fixture only ever builds a single-value
// rule.
type StringFilterOperator = Extract<
  ConditionRule,
  { fieldType: "string"; value: string }
>["operator"];
type NumberFilterOperator = Extract<
  ConditionRule,
  { fieldType: "number"; value: number }
>["operator"];

/**
 * One finished rule over `path`, as the Lifecycle panel would serialize it.
 *
 * `fieldType` and `operator` are declared as a union rather than two
 * independent fields so that narrowing `input.fieldType` below also narrows
 * `input.operator`, which is what lets the built rule satisfy `ConditionRule`
 * without a cast.
 */
export function filterOn(
  input:
    | {
        path: string;
        fieldType: "string";
        operator: StringFilterOperator;
        value: string;
      }
    | {
        path: string;
        fieldType: "number";
        operator: NumberFilterOperator;
        value: number;
      }
): string {
  const condition: ConditionRule =
    input.fieldType === "string"
      ? {
          id: "rule",
          field: input.path,
          fieldType: input.fieldType,
          operator: input.operator,
          value: input.value,
        }
      : {
          id: "rule",
          field: input.path,
          fieldType: input.fieldType,
          operator: input.operator,
          value: input.value,
        };

  return serializeConditionModel({
    version: 2,
    groupLogic: "and",
    groups: [
      {
        id: "group",
        logic: "and",
        conditions: [condition],
      },
    ],
  });
}

/** Start Rules whose one Start Event carries this filter. */
export function filteredRules(
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

export function guardedRules(input: {
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

export function guardedCancelRules(cancelFilter?: string): LifecycleRules {
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

export const startRules: LifecycleRules = {
  startEvents: ["app/appointment.created"],
  cancelEvents: [],
  concurrency: "unlimited",
};

export function createExecution(): WorkflowExecution {
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

export const startedOutcome: EntityStartOutcome = {
  status: "started",
  execution: createExecution(),
  supersededExecutionIds: [],
  reclaimedExecutionIds: [],
};

/**
 * The Execution an earlier attempt of a delivery committed. `enqueuedAt` is
 * null when that attempt died before the send.
 */
export function winnerExecution(input: {
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
export function winnerOutcome(input: {
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

/**
 * The entry node, carrying the rules under test and nothing else, unless the
 * case hands over a whole graph because what it asks about is the graph.
 */
export function createWorkflow(input: {
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

export function publishedVersion(workflow: Workflow): PublishedWorkflowVersion {
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

export function stubPublishedWorkflow(workflow: Workflow) {
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

export function subscriber(): EventSubscriber {
  return {
    id: "wf_1",
    roles: ["start"],
    correlationPath: null,
    connectionId: null,
  };
}

export const lifecyclePorts = Layer.mergeAll(
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
export function workflowWith(rules: LifecycleRules) {
  return Layer.mergeAll(
    stubPublishedWorkflow(createWorkflow({ rules })),
    lifecyclePorts
  );
}

/**
 * Puts every mock above back to its default behaviour. Each consuming file
 * calls this from its own `beforeEach`, since the mocks are shared instances
 * (see the module header) and a file's `beforeEach` only runs ahead of that
 * file's own cases.
 */
export function resetGuardedStartMocks(): void {
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
}
