import { assert, describe, layer } from "@effect/vitest";
// The mocks API has to be the one vitest itself exports; reaching it through the
// `@effect/vitest` re-export leaves it unable to find the module registry.
import { beforeEach, vi } from "vitest";
import { Effect, Layer } from "effect";
import type { Workflow } from "#src/backend/lib/db/schema";
import { DatabaseError } from "#src/backend/lib/effect/database";
import {
  SilentAppLoggerLayer,
  stubExecutionRepo,
  stubExtensionCatalog,
  stubInngestClient,
  stubIntegrationRepo,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import { createSerializedWorkflowGraph } from "@rova/shared/workflow/graph";
import type { LifecycleRules } from "@rova/shared/workflow/lifecycle-rules";
import type { EventSubscriber } from "#src/backend/services/workflows/repo";
import { applyLifecycleRules, deliverToWaits } from "./deliver-event";

// The two neighbours whose own cases live elsewhere, replaced for this file.
const {
  listWaitsForEventMock,
  resumeWaitsMatchingEventMock,
  validateWorkflowIntegrationsMock,
  startWithConcurrencyMock,
  requestCanceledOutletMock,
} = vi.hoisted(() => ({
  listWaitsForEventMock: vi.fn(),
  resumeWaitsMatchingEventMock: vi.fn(),
  validateWorkflowIntegrationsMock: vi.fn(),
  startWithConcurrencyMock: vi.fn(),
  requestCanceledOutletMock: vi.fn(),
}));

vi.mock("#src/backend/services/workflows/lifecycle/resume-waits", () => ({
  resumeWaitsMatchingEvent: resumeWaitsMatchingEventMock,
}));

// Concurrency's own cases are `concurrency.test.ts`; what matters here is what it
// is asked for and what its answer does to the delivery.
vi.mock("#src/backend/services/workflows/lifecycle/concurrency", () => ({
  startWithConcurrency: startWithConcurrencyMock,
}));

// The claim and the nudge are `cancel.test.ts`; here it is what the cancel arm
// asks for and what its answer keeps off the wait delivery.
vi.mock("#src/backend/services/workflows/lifecycle/cancel", () => ({
  requestCanceledOutlet: requestCanceledOutletMock,
}));

vi.mock("#src/backend/lib/workflow-integration-validation", () => ({
  validateWorkflowIntegrations: validateWorkflowIntegrationsMock,
}));

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

/** The entry node, carrying the rules under test and nothing else. */
function lifecycleGraph(rules?: LifecycleRules): Workflow["graph"] {
  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: "lifecycle-1",
        type: "trigger",
        position: { x: 0, y: 0 },
        data: {
          label: "Start",
          type: "trigger",
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
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
  };
}

function subscriber(overrides: Partial<EventSubscriber> = {}): EventSubscriber {
  return {
    id: "wf_1",
    name: "Appointment Reminders",
    mode: "live",
    roles: ["start"],
    correlationPath: null,
    ...overrides,
  };
}

/** The run seams, left refusing: the start path is replaced above them. */
const unreachedRunSeams = Layer.mergeAll(
  stubExecutionRepo(),
  stubInngestClient(),
  stubIntegrationRepo()
);

beforeEach(() => {
  vi.clearAllMocks();
  listWaitsForEventMock.mockReturnValue(Effect.succeed([]));
  resumeWaitsMatchingEventMock.mockReturnValue(Effect.succeed(0));
  validateWorkflowIntegrationsMock.mockReturnValue(
    Effect.succeed({ valid: true })
  );
  startWithConcurrencyMock.mockReturnValue(
    Effect.succeed({
      status: "started",
      executionId: "exec_new",
      runId: "evt_1",
      supersededExecutionIds: [],
      failedToSupersede: [],
    })
  );
  requestCanceledOutletMock.mockReturnValue(Effect.succeed(["exec_running"]));
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
              stubWorkflowRepo({
                findById: () =>
                  Effect.succeed(createWorkflow({ rules: startRules })),
              }),
              unreachedRunSeams
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
          startWithConcurrencyMock.mock.calls[0]?.[0].start.entityValue,
          "appt_8813"
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
              stubWorkflowRepo({
                findById: () =>
                  Effect.succeed(createWorkflow({ rules: startRules })),
              }),
              unreachedRunSeams
            )
          )
        );

        assert.strictEqual(
          startWithConcurrencyMock.mock.calls[0]?.[0].start.entityValue,
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
              stubWorkflowRepo({
                findById: () => Effect.succeed(createWorkflow({})),
              }),
              unreachedRunSeams
            )
          )
        );

        assert.deepStrictEqual(outcome, {
          kind: "waits_only",
          workflowId: "wf_1",
        });
        assert.strictEqual(startWithConcurrencyMock.mock.calls.length, 0);
      })
    );

    it.effect("carries a first-wins refusal back as refused", () =>
      Effect.gen(function* () {
        startWithConcurrencyMock.mockReturnValue(
          Effect.succeed({
            status: "not_started",
            reason: "concurrency_first_wins",
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
              stubWorkflowRepo({
                findById: () =>
                  Effect.succeed(createWorkflow({ rules: startRules })),
              }),
              unreachedRunSeams
            )
          )
        );

        assert.deepStrictEqual(outcome, {
          kind: "refused",
          workflowId: "wf_1",
          reason: "concurrency_first_wins",
        });
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
              stubWorkflowRepo({
                findById: () =>
                  Effect.succeed(createWorkflow({ rules: cancelRules })),
              }),
              unreachedRunSeams
            )
          )
        );

        assert.deepStrictEqual(outcome, {
          kind: "canceled",
          workflowId: "wf_1",
          canceledExecutionIds: ["exec_running"],
        });
        assert.deepStrictEqual(requestCanceledOutletMock.mock.calls[0]?.[0], {
          workflowId: "wf_1",
          runMode: "live",
          eventName: "app/appointment.canceled",
          payload,
          entityValue: "appt_8813",
        });
        assert.strictEqual(startWithConcurrencyMock.mock.calls.length, 0);
      })
    );

    // A cancel matches by Entity Value and has nothing else to match on, so a
    // payload carrying none reaches no run at all.
    it.effect("refuses a cancel whose payload carries no Entity Value", () =>
      Effect.gen(function* () {
        const outcome = yield* applyLifecycleRules({
          subscriber: subscriber({ roles: ["cancel"] }),
          event: appointmentCanceled,
          payload: { appointment: {} },
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubWorkflowRepo({
                findById: () =>
                  Effect.succeed(createWorkflow({ rules: cancelRules })),
              }),
              unreachedRunSeams
            )
          )
        );

        assert.deepStrictEqual(outcome, {
          kind: "refused",
          workflowId: "wf_1",
          reason: "entity_value_missing",
        });
        assert.strictEqual(requestCanceledOutletMock.mock.calls.length, 0);
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
              stubWorkflowRepo({
                findById: () =>
                  Effect.succeed(createWorkflow({ rules: startRules })),
              }),
              unreachedRunSeams
            )
          )
        );

        assert.deepStrictEqual(outcome, {
          kind: "waits_only",
          workflowId: "wf_1",
        });
        assert.strictEqual(requestCanceledOutletMock.mock.calls.length, 0);
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
              stubWorkflowRepo({ findById: () => Effect.succeed(null) }),
              unreachedRunSeams
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
              stubWorkflowRepo({
                findById: () =>
                  Effect.succeed(
                    createWorkflow({
                      graph: createSerializedWorkflowGraph({
                        nodes: [],
                        edges: [],
                      }),
                    })
                  ),
              }),
              unreachedRunSeams
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
                findById: () =>
                  Effect.fail(
                    new DatabaseError({
                      cause: new Error("terminating connection due to crash"),
                    })
                  ),
              }),
              unreachedRunSeams
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
  layer(
    Layer.mergeAll(
      SilentAppLoggerLayer,
      catalogLayer,
      stubInngestClient(),
      stubExecutionRepo({ listWaitsForEvent: listWaitsForEventMock })
    )
  )((it) => {
    // Candidates are found by Event name, and each row's own compiled match
    // decides. Nothing here reads a Correlation Path, which is what lets a run
    // park on an Event that has no entity of its own.
    it.effect("offers the Event to the runs parked on its name", () =>
      Effect.gen(function* () {
        listWaitsForEventMock.mockReturnValueOnce(
          Effect.succeed([{ id: "wait_1", executionId: "exec_parked" }])
        );
        resumeWaitsMatchingEventMock.mockReturnValueOnce(Effect.succeed(1));

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
          },
        ]);
      })
    );

    // A run this delivery settled takes nothing: one is ending, and the other has
    // parked nothing yet.
    it.effect("leaves out the runs the lifecycle just settled", () =>
      Effect.gen(function* () {
        listWaitsForEventMock.mockReturnValueOnce(
          Effect.succeed([{ id: "wait_1", executionId: "exec_superseded" }])
        );

        const outcome = yield* deliverToWaits({
          subscriber: subscriber(),
          event: appointmentCreated,
          payload,
          excluding: ["exec_superseded"],
        }).pipe(Effect.provide(stubWorkflowRepo()));

        assert.strictEqual(outcome.resumedWaits, 0);
        assert.strictEqual(resumeWaitsMatchingEventMock.mock.calls.length, 0);
      })
    );

    // The failure this replaces: an Event nobody declared a path for reached no
    // parked run at all, whatever the Wait node had asked for.
    it.effect("reaches parked runs with no Correlation Path in sight", () =>
      Effect.gen(function* () {
        listWaitsForEventMock.mockReturnValueOnce(
          Effect.succeed([{ id: "wait_1", executionId: "exec_parked" }])
        );
        resumeWaitsMatchingEventMock.mockReturnValueOnce(Effect.succeed(1));

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
          },
        ]);
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
        assert.strictEqual(resumeWaitsMatchingEventMock.mock.calls.length, 0);
      })
    );
  });
});
