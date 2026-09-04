import { assert, describe, layer } from "@effect/vitest";
// The mocks API has to be the one vitest itself exports; reaching it through the
// `@effect/vitest` re-export leaves it unable to find the module registry.
import { beforeEach, vi } from "vitest";
import { Effect, Layer } from "effect";
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
import type { ConditionModel } from "@wfgraph/shared/conditions/conditions";
import { serializeConditionModel } from "@wfgraph/shared/conditions/conditions";
import type { LifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type {
  EntityStartOutcome,
  ExecutionRepo,
  WorkflowExecution,
} from "#src/backend/services/executions/repo";
import type { EventSubscriber } from "#src/backend/services/workflows/repo";
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
const recordAuditEventMock = vi.fn<Repo["recordAuditEvent"]>(() => Effect.void);
const sendRunRequestedMock = vi.fn<
  InngestClient["Service"]["sendRunRequested"]
>(() => Effect.succeed({ eventId: "evt_1" }));
const sendCancelRequestedMock = vi.fn<
  InngestClient["Service"]["sendCancelRequested"]
>(() => Effect.void);

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
    },
  ],
});

const appointmentCreated = {
  name: "app/appointment.created",
  correlationPath: "appointment.id",
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
  };
}

const startedOutcome: EntityStartOutcome = {
  status: "started",
  execution: createExecution(),
  supersededExecutionIds: [],
  reclaimedExecutionIds: [],
};

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
  recordAuditEventMock.mockReset();
  sendRunRequestedMock.mockReset();
  sendCancelRequestedMock.mockReset();

  startForEntityMock.mockImplementation(() => Effect.succeed(startedOutcome));
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
