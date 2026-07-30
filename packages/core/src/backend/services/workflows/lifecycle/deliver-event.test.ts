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
  stubInngestClient,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import { createSerializedWorkflowGraph } from "@rova/shared/workflow/graph";
import type { LifecycleRules } from "@rova/shared/workflow/lifecycle-rules";
import type { EventSubscriber } from "#src/backend/services/workflows/repo";
import { applyLifecycleRules, deliverToWaits } from "./deliver-event";

// The modules holding their own database handle, replaced for this file.
const {
  logWorkflowAuditEventMock,
  resumeMatchingWaitHooksMock,
  listWaitingMock,
  validateWorkflowIntegrationsMock,
  startWithConcurrencyMock,
} = vi.hoisted(() => ({
  logWorkflowAuditEventMock: vi.fn(),
  resumeMatchingWaitHooksMock: vi.fn(),
  listWaitingMock: vi.fn(),
  validateWorkflowIntegrationsMock: vi.fn(),
  startWithConcurrencyMock: vi.fn(),
}));

vi.mock("#src/backend/lib/workflow-audit", () => ({
  logWorkflowAuditEvent: logWorkflowAuditEventMock,
}));

vi.mock("#src/backend/lib/workflow-wait-resume", () => ({
  resumeMatchingWaitHooks: resumeMatchingWaitHooksMock,
}));

vi.mock("#src/backend/lib/workflow-wait-state", () => ({
  listWorkflowWaitingStatesByCorrelation: listWaitingMock,
}));

// Concurrency's own cases are `concurrency.test.ts`; what matters here is what it
// is asked for and what its answer does to the delivery.
vi.mock("#src/backend/services/workflows/lifecycle/concurrency", () => ({
  startWithConcurrency: startWithConcurrencyMock,
}));

vi.mock("#src/backend/lib/workflow-integration-validation", () => ({
  validateWorkflowIntegrations: validateWorkflowIntegrationsMock,
}));

// The catalog the save rules are checked against, which preflight reaches for
// through the module `createRovaApp` configures.
vi.mock("#src/backend/lib/extensions/current", () => ({
  getExtensions: () => ({
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
  }),
}));

const appointmentCreated = {
  name: "app/appointment.created",
  correlationPath: "appointment.id",
};

const payload = { appointment: { id: "appt_8813" } };

const startRules: LifecycleRules = {
  startEvents: ["app/appointment.created"],
  cancelEvents: [],
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
  stubInngestClient()
);

beforeEach(() => {
  vi.clearAllMocks();
  logWorkflowAuditEventMock.mockResolvedValue(undefined);
  listWaitingMock.mockResolvedValue([]);
  resumeMatchingWaitHooksMock.mockResolvedValue(0);
  validateWorkflowIntegrationsMock.mockResolvedValue({ valid: true });
  startWithConcurrencyMock.mockReturnValue(
    Effect.succeed({
      status: "started",
      executionId: "exec_new",
      runId: "evt_1",
      supersededExecutionIds: [],
      failedToSupersede: [],
    })
  );
});

describe("applyLifecycleRules", () => {
  layer(SilentAppLoggerLayer)((it) => {
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
  layer(SilentAppLoggerLayer)((it) => {
    it.effect("wakes the waits parked on this entity", () =>
      Effect.gen(function* () {
        listWaitingMock.mockResolvedValueOnce([
          { id: "wait_1", executionId: "exec_parked" },
        ]);
        resumeMatchingWaitHooksMock.mockResolvedValueOnce(1);

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
        assert.deepStrictEqual(listWaitingMock.mock.calls[0], [
          { workflowId: "wf_1", correlationKey: "appt_8813", runMode: "live" },
        ]);
      })
    );

    // A run this delivery settled takes nothing: one is ending, and the other has
    // parked nothing yet.
    it.effect("leaves out the runs the lifecycle just settled", () =>
      Effect.gen(function* () {
        listWaitingMock.mockResolvedValueOnce([
          { id: "wait_1", executionId: "exec_superseded" },
        ]);

        const outcome = yield* deliverToWaits({
          subscriber: subscriber(),
          event: appointmentCreated,
          payload,
          excluding: ["exec_superseded"],
        }).pipe(Effect.provide(stubWorkflowRepo()));

        assert.strictEqual(outcome.resumedWaits, 0);
        assert.strictEqual(resumeMatchingWaitHooksMock.mock.calls.length, 0);
      })
    );

    it.effect("reaches no wait when the payload carries no Entity Value", () =>
      Effect.gen(function* () {
        const outcome = yield* deliverToWaits({
          subscriber: subscriber(),
          event: appointmentCreated,
          payload: { appointment: {} },
          excluding: [],
        }).pipe(Effect.provide(stubWorkflowRepo()));

        assert.strictEqual(outcome.resumedWaits, 0);
        assert.strictEqual(listWaitingMock.mock.calls.length, 0);
      })
    );

    // An Event declaring its own Correlation Path needs no rules, so no graph
    // read: that column runs to megabytes and this path runs per delivery.
    it.effect("reads no graph for an Event that declares its own path", () =>
      Effect.gen(function* () {
        const findById = vi.fn(() => Effect.succeed(null));

        yield* deliverToWaits({
          subscriber: subscriber({ roles: ["wait"] }),
          event: appointmentCreated,
          payload,
          excluding: [],
        }).pipe(Effect.provide(stubWorkflowRepo({ findById })));

        assert.strictEqual(findById.mock.calls.length, 0);
      })
    );

    // An Event whose author declared none falls back to the builder's override,
    // which lives on the entry node: the one wait delivery that reads a graph.
    // An Event declaring no Correlation Path leaves the builder's override to say
    // where the entity sits, and it arrives on the subscription row: reading it
    // off the graph would mean a megabyte-class read per delivery.
    it.effect("falls back to the builder's own Correlation Path", () =>
      Effect.gen(function* () {
        listWaitingMock.mockResolvedValueOnce([
          { id: "wait_1", executionId: "exec_parked" },
        ]);
        resumeMatchingWaitHooksMock.mockResolvedValueOnce(1);

        const outcome = yield* deliverToWaits({
          subscriber: subscriber({
            roles: ["wait"],
            correlationPath: "sweep.id",
          }),
          event: { name: "ops/nightly.swept" },
          payload: { sweep: { id: "sweep_1" } },
          excluding: [],
        }).pipe(Effect.provide(stubWorkflowRepo({})));

        assert.strictEqual(outcome.resumedWaits, 1);
        assert.deepStrictEqual(listWaitingMock.mock.calls[0], [
          { workflowId: "wf_1", correlationKey: "sweep_1", runMode: "live" },
        ]);
      })
    );

    // Neither side says where the entity sits, so no parked run can be matched.
    // The delivery says so and wakes nothing rather than guessing.
    it.effect("wakes nothing when no Correlation Path is known", () =>
      Effect.gen(function* () {
        const outcome = yield* deliverToWaits({
          subscriber: subscriber({ roles: ["wait"] }),
          event: { name: "ops/nightly.swept" },
          payload: { sweep: { id: "sweep_1" } },
          excluding: [],
        }).pipe(Effect.provide(stubWorkflowRepo({})));

        assert.strictEqual(outcome.resumedWaits, 0);
        assert.strictEqual(listWaitingMock.mock.calls.length, 0);
      })
    );
  });
});
