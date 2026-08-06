import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type { Workflow, WorkflowVersion } from "#src/backend/lib/db/schema";
import { Conflict } from "#src/backend/lib/effect/failures";
import {
  SilentAppLoggerLayer,
  stubExtensionCatalog,
  stubIntegrationRepo,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import { publishWorkflow } from "#src/backend/services/workflows/publish";
import type { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { createSerializedWorkflowGraph } from "@rova/shared/graph/graph";
import type { LifecycleRules } from "@rova/shared/lifecycle/lifecycle-rules";

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

function graphWith(rules: LifecycleRules): Workflow["graph"] {
  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: "lifecycle-1",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: {
          label: "Start",
          type: "lifecycle",
          config: { lifecycleRules: rules },
        },
      },
    ],
    edges: [],
  });
}

const rules: LifecycleRules = {
  startEvents: ["app/appointment.created"],
  cancelEvents: [],
  concurrency: "unlimited",
};

const draft: Workflow = {
  id: "wf_1",
  name: "Appointment Reminders",
  description: null,
  graph: graphWith(rules),
  isPaused: false,
  mode: "live",
  visibility: "private",
  publishedVersionId: null,
  createdAt: new Date("2026-03-01T00:00:00.000Z"),
  updatedAt: new Date("2026-03-01T00:00:00.000Z"),
};

describe("publishWorkflow", () => {
  layer(
    Layer.mergeAll(
      SilentAppLoggerLayer,
      catalogLayer,
      stubIntegrationRepo({ typesByIds: () => Effect.succeed({}) })
    )
  )((it) => {
    it.effect("inserts a version and rewrites subscriptions", () =>
      Effect.gen(function* () {
        const inserted: Array<
          Parameters<WorkflowRepo["Service"]["insertPublishedVersion"]>[0]
        > = [];

        const repo = stubWorkflowRepo({
          findById: () => Effect.succeed(draft),
          findVersionByContent: () => Effect.succeed(null),
          findLatestVersion: () => Effect.succeed(null),
          insertPublishedVersion: (input) =>
            Effect.sync(() => {
              inserted.push(input);
              const version: WorkflowVersion = {
                id: input.versionId,
                workflowId: input.workflowId,
                version: input.version,
                graph: input.draftGraph,
                catalogFingerprint: input.catalogFingerprint,
                graphDigest: input.graphDigest,
                publishedAt: new Date("2026-08-03T00:00:00.000Z"),
              };
              return {
                workflow: {
                  ...draft,
                  publishedVersionId: version.id,
                  graph: version.graph,
                },
                version,
              };
            }),
        });

        const result = yield* publishWorkflow({
          workflowId: "wf_1",
          graph: draft.graph,
        }).pipe(Effect.provide(repo));

        assert.strictEqual(result.publishedVersion, 1);
        assert.strictEqual(result.hasUnpublishedChanges, false);
        assert.strictEqual(inserted.length, 1);
        assert.strictEqual(inserted[0]?.version, 1);
        assert.ok(inserted[0]?.eventSubscriptions.length === 1);
        assert.strictEqual(
          inserted[0]?.eventSubscriptions[0]?.eventName,
          "app/appointment.created"
        );
      })
    );

    it.effect("reuses a version whose digest and fingerprint match", () =>
      Effect.gen(function* () {
        const existing: WorkflowVersion = {
          id: "ver_1",
          workflowId: "wf_1",
          version: 3,
          graph: draft.graph,
          catalogFingerprint: "",
          graphDigest: "",
          publishedAt: new Date("2026-08-01T00:00:00.000Z"),
        };

        let capturedDigest = "";
        let capturedFingerprint = "";
        const mint = stubWorkflowRepo({
          findById: () => Effect.succeed(draft),
          findVersionByContent: () => Effect.succeed(null),
          findLatestVersion: () => Effect.succeed(null),
          insertPublishedVersion: (input) =>
            Effect.sync(() => {
              capturedDigest = input.graphDigest;
              capturedFingerprint = input.catalogFingerprint;
              return {
                workflow: { ...draft, publishedVersionId: input.versionId },
                version: {
                  id: input.versionId,
                  workflowId: input.workflowId,
                  version: input.version,
                  graph: input.draftGraph,
                  catalogFingerprint: capturedFingerprint,
                  graphDigest: capturedDigest,
                  publishedAt: new Date(),
                },
              };
            }),
        });
        yield* publishWorkflow({
          workflowId: "wf_1",
          graph: draft.graph,
        }).pipe(Effect.provide(mint));

        const reused: string[] = [];
        const repo = stubWorkflowRepo({
          findById: () => Effect.succeed(draft),
          findVersionByContent: () =>
            Effect.succeed({
              ...existing,
              graphDigest: capturedDigest,
              catalogFingerprint: capturedFingerprint,
              graph: draft.graph,
            }),
          setPublishedVersion: (input) =>
            Effect.sync(() => {
              reused.push(input.versionId);
              return {
                workflow: { ...draft, publishedVersionId: input.versionId },
                version: {
                  ...existing,
                  graphDigest: capturedDigest,
                  catalogFingerprint: capturedFingerprint,
                },
              };
            }),
        });

        const result = yield* publishWorkflow({
          workflowId: "wf_1",
          graph: draft.graph,
        }).pipe(Effect.provide(repo));

        assert.strictEqual(result.publishedVersion, 3);
        assert.deepStrictEqual(reused, ["ver_1"]);
      })
    );

    it.effect("answers Conflict when the version claim is stale", () =>
      Effect.gen(function* () {
        const repo = stubWorkflowRepo({
          findById: () => Effect.succeed(draft),
          findVersionByContent: () => Effect.succeed(null),
          findLatestVersion: () =>
            Effect.succeed({
              id: "ver_1",
              workflowId: "wf_1",
              version: 2,
              graph: draft.graph,
              catalogFingerprint: "",
              graphDigest: "",
              publishedAt: new Date(),
            }),
          insertPublishedVersion: () => Effect.succeed({ stale: true }),
        });

        const failure = yield* publishWorkflow({
          workflowId: "wf_1",
          graph: draft.graph,
        }).pipe(Effect.provide(repo), Effect.flip);

        assert.instanceOf(failure, Conflict);
        assert.ok(
          failure.error.includes("Refresh"),
          `expected refresh guidance, got: ${failure.error}`
        );
      })
    );
  });
});
