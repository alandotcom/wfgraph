// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type { Workflow } from "#src/backend/lib/db/schema";
import {
  SilentAppLoggerLayer,
  stubExecutionRepo,
  stubExtensionCatalog,
  stubInngestClient,
  stubIntegrationRepo,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import type { ExecutionRepo } from "#src/backend/services/executions/repo";
import type { WorkflowExecution } from "#src/backend/services/executions/repo/contracts";
import { postWorkflowExecute } from "#src/backend/services/workflows/lifecycle/manual-start";
import type { LifecycleRules } from "@rova/shared/workflow/lifecycle-rules";
import { createSerializedWorkflowGraph } from "@rova/shared/workflow/graph";

function graphWithRules(rules: LifecycleRules) {
  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: "trigger-1",
        type: "trigger",
        position: { x: 0, y: 0 },
        data: {
          label: "Appointment",
          type: "trigger",
          config: { lifecycleRules: rules },
        },
      },
    ],
    edges: [],
  });
}

const startRules: LifecycleRules = {
  startEvent: "app/appointment.created",
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
    triggerEventType: null,
    correlationKey: null,
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
function makeRepo() {
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
      }),
      stubInngestClient({
        sendRunRequested: () => Effect.succeed({ eventId: "evt_1" }),
      })
    ),
  };
}

const catalogLayer = stubExtensionCatalog({
  events: [
    {
      name: "app/appointment.created",
      label: "Appointment created",
      correlationPath: "appointment.id",
      payloadFields: [],
    },
  ],
});

function workflowLayer(workflow: Workflow) {
  return stubWorkflowRepo({ findById: () => Effect.succeed(workflow) });
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

        assert.strictEqual(repo.starts[0]?.entityValue, "appt_1");
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

        assert.strictEqual(repo.starts[0]?.entityValue, "workflow:wf_1");
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
                        id: "trigger-1",
                        type: "trigger",
                        position: { x: 0, y: 0 },
                        data: { label: "Start", type: "trigger", config: {} },
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
        assert.strictEqual(repo.starts[0]?.entityValue, "workflow:wf_1");
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
        assert.strictEqual(audit?.eventType, "run_not_started");
        assert.isUndefined(audit?.executionId);
        assert.strictEqual(audit?.metadata?.reason, "manual_start_not_allowed");
        assert.include(audit?.message, "does not list manual runs");
      })
    );
  });
});
