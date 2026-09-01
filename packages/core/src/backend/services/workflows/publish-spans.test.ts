/**
 * The trace a publish leaves: span names, the identifiers on them, and the
 * absence of everything else. These names are what a host's dashboards key off,
 * so a rename here is a released change (docs/embedding.md, "Tracing").
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Effect, Layer } from "effect";
import type {
  PublishedWorkflowVersion,
  Workflow,
} from "#src/backend/lib/db/schema";
import {
  expectIdentifierAttributesOnly,
  lifecycleGraphFixture,
  recordSpans,
  type SpanRecording,
  spanFixtureCatalog,
} from "#src/backend/lib/effect/span-test-support";
import {
  SilentAppLoggerLayer,
  stubExtensionCatalog,
  stubIntegrationRepo,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import { TracerBridgeLayer } from "#src/backend/lib/effect/tracer";
import { publishWorkflow } from "#src/backend/services/workflows/publish";
import {
  compareWorkflowVersion,
  getWorkflowVersionHistory,
  restoreWorkflowVersion,
} from "#src/backend/services/workflows/versions";
import type { WorkflowRepo } from "#src/backend/services/workflows/repo/index";
import type { LifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { PUBLICATION_CONFLICT_CODES } from "@wfgraph/shared/rpc/error-codes";

/**
 * Every attribute key a Workflow Graph service span may carry, written out here rather
 * than imported so the assertion is an independent statement of the contract.
 */
const ALLOWED_ATTRIBUTE_KEYS = new Set([
  "wfgraph.workflow.id",
  "wfgraph.execution.id",
  "wfgraph.workflow.version.id",
  "wfgraph.workflow.version.base_id",
  "wfgraph.workflow.version.number",
  "wfgraph.outcome",
]);

/** Strings that only ever appear inside the graph, so no attribute may hold one. */
const GRAPH_ONLY_STRINGS = [
  "lifecycle-1",
  "Appointment reminder start",
  "app/appointment.created",
  "lifecycleRules",
];

const rules: LifecycleRules = {
  startEvents: ["app/appointment.created"],
  cancelEvents: [],
  concurrency: "unlimited",
};

function graphWith(label = "Appointment reminder start"): Workflow["graph"] {
  return lifecycleGraphFixture({ label, rules });
}

const draft: Workflow = {
  id: "wf_1",
  name: "Appointment Reminders",
  description: null,
  graph: graphWith(),
  isPaused: false,
  mode: "live",
  visibility: "private",
  publishedVersionId: null,
  createdAt: new Date("2026-03-01T00:00:00.000Z"),
  updatedAt: new Date("2026-03-01T00:00:00.000Z"),
};

function versionRow(
  overrides: Partial<PublishedWorkflowVersion> = {}
): PublishedWorkflowVersion {
  return {
    id: "ver_1",
    workflowId: "wf_1",
    version: 1,
    kind: "published",
    graph: graphWith(),
    catalogFingerprint: "fp",
    graphDigest: "digest",
    publishedAt: new Date("2026-03-01T00:00:00.000Z"),
    ...overrides,
  };
}

/** What `insertPublishedVersion` answers for the input it was handed. */
function mintedFrom(
  input: Parameters<WorkflowRepo["Service"]["insertPublishedVersion"]>[0]
): { workflow: Workflow; version: PublishedWorkflowVersion } {
  const version = versionRow({
    id: input.versionId,
    version: input.version,
    graph: input.draftGraph,
    catalogFingerprint: input.catalogFingerprint,
    graphDigest: input.graphDigest,
  });
  return {
    workflow: {
      ...draft,
      publishedVersionId: version.id,
      graph: version.graph,
    },
    version,
  };
}

const shared = Layer.mergeAll(
  TracerBridgeLayer,
  SilentAppLoggerLayer,
  stubExtensionCatalog(spanFixtureCatalog),
  stubIntegrationRepo({ typesByIds: () => Effect.succeed({}) })
);

let spans: SpanRecording;

beforeEach(() => {
  spans = recordSpans();
});

afterEach(async () => {
  await spans.stop();
});

describe("workflow publication spans", () => {
  test("names the publish span and its readiness child", async () => {
    const repo = stubWorkflowRepo({
      findById: () => Effect.succeed(draft),
      findPublishedVersion: () => Effect.succeed(null),
      findLatestVersion: () => Effect.succeed(null),
      insertPublishedVersion: (input) => Effect.succeed(mintedFrom(input)),
    });

    await Effect.runPromise(
      publishWorkflow({
        workflowId: "wf_1",
        graph: draft.graph,
        expectedPublishedVersionId: null,
      }).pipe(Effect.provide(Layer.merge(shared, repo)))
    );

    const publish = await spans.named("wfgraph.workflow.publish");
    const readiness = await spans.named("wfgraph.workflow.publish_readiness");

    expect(publish?.instrumentationScope.name).toBe("wfgraph-workflows");
    expect(publish?.attributes).toMatchObject({
      "wfgraph.workflow.id": "wf_1",
      "wfgraph.workflow.version.number": 1,
      "wfgraph.outcome": "published",
    });
    expect(publish?.attributes["wfgraph.workflow.version.id"]).toBeTypeOf(
      "string"
    );
    expect(readiness?.parentSpanContext?.spanId).toBe(
      publish?.spanContext().spanId
    );
    expect(readiness?.attributes["wfgraph.outcome"]).toBe("ready");
  });

  test("records the conflict code as the publish outcome", async () => {
    const current = versionRow({ id: "ver_8", version: 8 });
    const repo = stubWorkflowRepo({
      findById: () => Effect.succeed({ ...draft, publishedVersionId: "ver_8" }),
      findPublishedVersion: () => Effect.succeed(current),
      findLatestVersion: () => Effect.succeed(current),
    });

    await Effect.runPromise(
      publishWorkflow({
        workflowId: "wf_1",
        graph: draft.graph,
        expectedPublishedVersionId: "ver_8",
      }).pipe(Effect.provide(Layer.merge(shared, repo)), Effect.flip)
    );

    const publish = await spans.named("wfgraph.workflow.publish");
    expect(publish?.attributes["wfgraph.outcome"]).toBe(
      PUBLICATION_CONFLICT_CODES.alreadyPublished
    );
    expect(publish?.attributes["wfgraph.workflow.id"]).toBe("wf_1");
  });

  test("names the version compare span and the base version it read", async () => {
    const base = versionRow({ id: "ver_3", version: 3 });
    const repo = stubWorkflowRepo({
      findById: () => Effect.succeed({ ...draft, publishedVersionId: "ver_3" }),
      findVersionById: () => Effect.succeed(base),
      findLatestVersion: () => Effect.succeed(base),
    });

    await Effect.runPromise(
      compareWorkflowVersion({
        workflowId: "wf_1",
        baseVersionId: "ver_3",
        draftGraph: graphWith(),
      }).pipe(Effect.provide(Layer.merge(shared, repo)))
    );

    const compare = await spans.named("wfgraph.workflow.version.compare");
    expect(compare?.attributes).toMatchObject({
      "wfgraph.workflow.id": "wf_1",
      "wfgraph.workflow.version.base_id": "ver_3",
    });
  });

  test("names the version history span", async () => {
    const repo = stubWorkflowRepo({
      existsById: () => Effect.succeed(true),
      listVersionHistoryPage: () =>
        Effect.succeed([{ ...versionRow(), isCurrent: true }]),
    });

    await Effect.runPromise(
      getWorkflowVersionHistory({ workflowId: "wf_1" }).pipe(
        Effect.provide(Layer.merge(shared, repo))
      )
    );

    const history = await spans.named("wfgraph.workflow.version.history");
    expect(history?.attributes).toMatchObject({
      "wfgraph.workflow.id": "wf_1",
    });
  });

  test("names the version restore span and the version it restored", async () => {
    const restored = versionRow({ id: "ver_2", version: 2 });
    const repo = stubWorkflowRepo({
      findById: () => Effect.succeed(draft),
      findVersionById: () => Effect.succeed(restored),
      update: () => Effect.succeed(draft),
    });

    await Effect.runPromise(
      restoreWorkflowVersion({ workflowId: "wf_1", versionId: "ver_2" }).pipe(
        Effect.provide(Layer.merge(shared, repo))
      )
    );

    const restore = await spans.named("wfgraph.workflow.version.restore");
    expect(restore?.attributes).toMatchObject({
      "wfgraph.workflow.id": "wf_1",
      "wfgraph.workflow.version.id": "ver_2",
    });
  });

  test("carries identifiers alone, never the graph", async () => {
    const repo = stubWorkflowRepo({
      findById: () => Effect.succeed(draft),
      findPublishedVersion: () => Effect.succeed(null),
      findLatestVersion: () => Effect.succeed(null),
      insertPublishedVersion: (input) => Effect.succeed(mintedFrom(input)),
    });

    await Effect.runPromise(
      publishWorkflow({
        workflowId: "wf_1",
        graph: draft.graph,
        expectedPublishedVersionId: null,
      }).pipe(Effect.provide(Layer.merge(shared, repo)))
    );

    expectIdentifierAttributesOnly(await spans.finished(), {
      allowed: ALLOWED_ATTRIBUTE_KEYS,
      forbidden: GRAPH_ONLY_STRINGS,
    });
  });
});
