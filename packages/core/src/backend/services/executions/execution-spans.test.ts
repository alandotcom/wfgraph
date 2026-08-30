/**
 * The trace a run's start and its cancellation leave: span names, the
 * identifiers on them, the nesting between them, and the absence of everything
 * else. These names are a released contract (docs/embedding.md, "Tracing").
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Effect, Layer } from "effect";
import type { Workflow } from "#src/backend/lib/db/schema";
import {
  expectIdentifierAttributesOnly,
  lifecycleGraphFixture,
  recordSpans,
  type SpanRecording,
  spanFixtureCatalog,
} from "#src/backend/lib/effect/span-test-support";
import {
  SilentAppLoggerLayer,
  stubExecutionRepo,
  stubExtensions,
  stubInngestClient,
  stubIntegrationRepo,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import { TracerBridgeLayer } from "#src/backend/lib/effect/tracer";
import { postExecutionCancel } from "#src/backend/services/executions/cancel";
import { postWorkflowExecute } from "#src/backend/services/workflows/lifecycle/manual-start";
import type { WorkflowExecution } from "#src/backend/services/executions/repo/contracts";
import type { LifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";

/** Every attribute key a Workflow Graph service span may carry, stated independently. */
const ALLOWED_ATTRIBUTE_KEYS = new Set([
  "wfgraph.workflow.id",
  "wfgraph.execution.id",
  "wfgraph.workflow.version.id",
  "wfgraph.workflow.version.base_id",
  "wfgraph.workflow.version.number",
  "wfgraph.outcome",
]);

/**
 * Strings that live only in the graph or in the run's payload, so no attribute
 * may hold one. `appt_1` is the payload value the Correlation Path reads.
 */
const PAYLOAD_ONLY_STRINGS = [
  "lifecycle-1",
  "Appointment reminder start",
  "app/appointment.created",
  "appt_1",
];

const startRules: LifecycleRules = {
  startEvents: ["app/appointment.created"],
  cancelEvents: [],
  concurrency: "unlimited",
  allowManualStart: true,
};

const catalogLayer = stubExtensions({ catalog: spanFixtureCatalog });

/**
 * A stored workflow. Preflight memoises its verdict on the graph's digest, which
 * the node label is part of, so each case passes its own label to get its own.
 */
function workflowRow(rules: LifecycleRules, label: string): Workflow {
  return {
    id: "wf_1",
    name: "Appointment Reminders",
    description: null,
    graph: lifecycleGraphFixture({ label, rules }),
    isPaused: false,
    mode: "live",
    visibility: "private",
    publishedVersionId: "ver_1",
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
    updatedAt: new Date("2026-02-01T00:00:00.000Z"),
  };
}

function workflowRepoFor(workflow: Workflow) {
  return stubWorkflowRepo({
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
  });
}

function executionRow(): WorkflowExecution {
  return {
    id: "exec_new",
    workflowId: "wf_1",
    workflowRunId: null,
    deliveryId: null,
    enqueuedAt: null,
    status: "running",
    startSource: "manual",
    runMode: "live",
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
  };
}

const startRepo = Layer.mergeAll(
  stubExecutionRepo({
    startForEntity: () =>
      Effect.succeed({
        status: "started" as const,
        execution: executionRow(),
        supersededExecutionIds: [],
        reclaimedExecutionIds: [],
      }),
    markEnqueued: () => Effect.void,
    recordAuditEvent: () => Effect.void,
  }),
  stubInngestClient({
    sendRunRequested: () => Effect.succeed({ eventId: "e" }),
  })
);

const shared = Layer.mergeAll(
  TracerBridgeLayer,
  SilentAppLoggerLayer,
  catalogLayer,
  stubIntegrationRepo()
);

let spans: SpanRecording;

beforeEach(() => {
  spans = recordSpans();
});

afterEach(async () => {
  await spans.stop();
});

describe("execution start and cancel spans", () => {
  test("nests the workflow load and its preflight under the start", async () => {
    const workflow = workflowRow(startRules, "Appointment reminder start");

    await Effect.runPromise(
      postWorkflowExecute("wf_1", {
        input: { appointment: { id: "appt_1" } },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(shared, startRepo, workflowRepoFor(workflow))
        )
      )
    );

    const start = await spans.named("wfgraph.execution.start");
    const load = await spans.named("wfgraph.execution.load_workflow");
    const preflight = await spans.named("wfgraph.execution.preflight");

    expect(start?.instrumentationScope.name).toBe("wfgraph-workflows");
    expect(load?.parentSpanContext?.spanId).toBe(start?.spanContext().spanId);
    expect(preflight?.parentSpanContext?.spanId).toBe(
      load?.spanContext().spanId
    );
    expect(start?.attributes).toMatchObject({
      "wfgraph.workflow.id": "wf_1",
      "wfgraph.execution.id": "exec_new",
      "wfgraph.outcome": "running",
    });
    expect(load?.attributes).toMatchObject({
      "wfgraph.workflow.id": "wf_1",
      "wfgraph.workflow.version.id": "ver_1",
    });
    expect(preflight?.attributes).toMatchObject({
      "wfgraph.workflow.version.id": "ver_1",
    });
  });

  // A refusal is the start span's own verdict rather than a span of its own: the
  // reason reaches the caller in the response and the timeline, and a child span
  // would name only the two reasons this one helper covers.
  test("records a refused start as the start span's outcome", async () => {
    const workflow = workflowRow(
      { ...startRules, allowManualStart: false },
      "Appointment reminder refused"
    );

    await Effect.runPromise(
      postWorkflowExecute("wf_1", { input: {} }).pipe(
        Effect.provide(
          Layer.mergeAll(shared, startRepo, workflowRepoFor(workflow))
        )
      )
    );

    const start = await spans.named("wfgraph.execution.start");
    expect(start?.attributes).toMatchObject({
      "wfgraph.workflow.id": "wf_1",
      "wfgraph.outcome": "ignored",
    });
    expect(start?.attributes["wfgraph.execution.id"]).toBeUndefined();
  });

  test("names the cancel span and the run it ended", async () => {
    const repo = Layer.mergeAll(
      stubExecutionRepo({
        findWorkflowIdById: () => Effect.succeed("wf_1"),
        findStatusById: () =>
          Effect.succeed({ id: "exec_1", status: "running" }),
        listWaitingStates: () => Effect.succeed([]),
        recordAuditEvent: () => Effect.void,
        endInFlight: () => Effect.succeed(true),
        cancelWaits: () => Effect.succeed([]),
      }),
      stubInngestClient({ sendCancelRequested: () => Effect.void })
    );

    await Effect.runPromise(
      postExecutionCancel("exec_1").pipe(
        Effect.provide(Layer.merge(shared, repo))
      )
    );

    const cancel = await spans.named("wfgraph.execution.cancel");
    expect(cancel?.attributes).toMatchObject({
      "wfgraph.execution.id": "exec_1",
      "wfgraph.workflow.id": "wf_1",
      "wfgraph.outcome": "canceled",
    });
  });

  test("carries identifiers alone, never the graph or the payload", async () => {
    const workflow = workflowRow(startRules, "Appointment reminder audited");

    await Effect.runPromise(
      postWorkflowExecute("wf_1", {
        input: { appointment: { id: "appt_1" } },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(shared, startRepo, workflowRepoFor(workflow))
        )
      )
    );

    expectIdentifierAttributesOnly(await spans.finished(), {
      allowed: ALLOWED_ATTRIBUTE_KEYS,
      forbidden: PAYLOAD_ONLY_STRINGS,
    });
  });
});
