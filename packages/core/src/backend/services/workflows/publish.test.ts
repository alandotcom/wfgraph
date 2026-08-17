import { assert, describe, it as standalone, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type { Workflow, WorkflowVersion } from "#src/backend/lib/db/schema";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { Conflict, InvalidInput } from "#src/backend/lib/effect/failures";
import {
  makeRecordingLogger,
  SilentAppLoggerLayer,
  stubExtensionCatalog,
  stubIntegrationRepo,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import {
  publishWorkflow,
  RETAINED_VERSIONS_PER_WORKFLOW,
} from "#src/backend/services/workflows/publish";
import type { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { LifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";

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

/** What `insertPublishedVersion` answers for the input it was handed. */
function mintedFrom(
  input: Parameters<WorkflowRepo["Service"]["insertPublishedVersion"]>[0]
): { workflow: Workflow; version: WorkflowVersion } {
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
}

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
          pruneUnreferencedVersions: () => Effect.succeed([]),
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
          pruneUnreferencedVersions: () => Effect.succeed([]),
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
          pruneUnreferencedVersions: () => Effect.succeed([]),
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

    it.effect(
      "refuses to reactivate a matching version after another publish won",
      () =>
        Effect.gen(function* () {
          const existing: WorkflowVersion = {
            id: "ver_old",
            workflowId: "wf_1",
            version: 1,
            graph: draft.graph,
            catalogFingerprint: "",
            graphDigest: "",
            publishedAt: new Date("2026-08-01T00:00:00.000Z"),
          };
          const observed = { ...draft, publishedVersionId: "ver_observed" };

          const repo = stubWorkflowRepo({
            findById: () => Effect.succeed(observed),
            findVersionByContent: (input) =>
              Effect.succeed({
                ...existing,
                graphDigest: input.graphDigest,
                catalogFingerprint: input.catalogFingerprint,
              }),
            setPublishedVersion: (input) =>
              Effect.sync(() => {
                assert.strictEqual(
                  input.expectedPublishedVersionId,
                  "ver_observed"
                );
                return { stale: true as const };
              }),
          });

          const failure = yield* publishWorkflow({
            workflowId: "wf_1",
            graph: draft.graph,
          }).pipe(Effect.provide(repo), Effect.flip);

          assert.instanceOf(failure, Conflict);
          assert.include(failure.error, "Refresh");
        })
    );

    // Publish is the only event that grows the version table, so the bound
    // holds continuously by sweeping here rather than on a schedule.
    it.effect("sweeps the workflow it just published", () =>
      Effect.gen(function* () {
        const swept: Array<
          Parameters<WorkflowRepo["Service"]["pruneUnreferencedVersions"]>[0]
        > = [];

        const repo = stubWorkflowRepo({
          findById: () => Effect.succeed(draft),
          findVersionByContent: () => Effect.succeed(null),
          findLatestVersion: () => Effect.succeed(null),
          pruneUnreferencedVersions: (input) =>
            Effect.sync(() => {
              swept.push(input);
              return [];
            }),
          insertPublishedVersion: (input) => Effect.succeed(mintedFrom(input)),
        });

        yield* publishWorkflow({
          workflowId: "wf_1",
          graph: draft.graph,
        }).pipe(Effect.provide(repo));

        assert.strictEqual(swept.length, 1);
        assert.strictEqual(swept[0]?.workflowId, "wf_1");
        assert.strictEqual(
          swept[0]?.keepNewest,
          RETAINED_VERSIONS_PER_WORKFLOW
        );
      })
    );

    // The reuse path is where a version most often becomes prunable: the one
    // the workflow pointed at a moment ago is now named by nothing.
    it.effect("sweeps on the reuse path too", () =>
      Effect.gen(function* () {
        const swept: string[] = [];
        const existing: WorkflowVersion = {
          id: "ver_1",
          workflowId: "wf_1",
          version: 3,
          graph: draft.graph,
          catalogFingerprint: "",
          graphDigest: "",
          publishedAt: new Date("2026-08-01T00:00:00.000Z"),
        };

        const repo = stubWorkflowRepo({
          findById: () => Effect.succeed(draft),
          findVersionByContent: (input) =>
            Effect.succeed({
              ...existing,
              graphDigest: input.graphDigest,
              catalogFingerprint: input.catalogFingerprint,
            }),
          pruneUnreferencedVersions: (input) =>
            Effect.sync(() => {
              swept.push(input.workflowId);
              return [];
            }),
          setPublishedVersion: () =>
            Effect.succeed({
              workflow: { ...draft, publishedVersionId: existing.id },
              version: existing,
            }),
        });

        yield* publishWorkflow({
          workflowId: "wf_1",
          graph: draft.graph,
        }).pipe(Effect.provide(repo));

        assert.deepStrictEqual(swept, ["wf_1"]);
      })
    );
  });

  // The version write has already committed by the time the sweep runs, so
  // letting its failure escape would answer a 500 for a publish that happened.
  // This case reads its own log lines, so it builds a logger rather than
  // joining the silent one the block above shares.
  standalone.effect("answers the publish even when the sweep fails", () =>
    Effect.gen(function* () {
      const recording = makeRecordingLogger();
      const repo = stubWorkflowRepo({
        findById: () => Effect.succeed(draft),
        findVersionByContent: () => Effect.succeed(null),
        findLatestVersion: () => Effect.succeed(null),
        pruneUnreferencedVersions: () =>
          Effect.fail(new DatabaseError({ cause: new Error("boom") })),
        insertPublishedVersion: (input) => Effect.succeed(mintedFrom(input)),
      });

      const result = yield* publishWorkflow({
        workflowId: "wf_1",
        graph: draft.graph,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            repo,
            recording.layer,
            catalogLayer,
            stubIntegrationRepo({ typesByIds: () => Effect.succeed({}) })
          )
        )
      );

      assert.strictEqual(result.publishedVersion, 1);
      assert.strictEqual(recording.warnLines.length, 1);
      assert.ok(
        recording.warnLines[0]?.message.includes("prune"),
        `expected a prune warning, got: ${recording.warnLines[0]?.message}`
      );
    })
  );

  /**
   * The other half of the draft/publish split. A graph the draft save now stores
   * without complaint has to stop here instead, and it has to stop before any
   * version row is minted.
   */
  standalone.effect("refuses a half-built graph and mints nothing", () =>
    Effect.gen(function* () {
      let minted = 0;
      const repo = stubWorkflowRepo({
        findById: () => Effect.succeed(draft),
        findVersionByContent: () => Effect.succeed(null),
        findLatestVersion: () => Effect.succeed(null),
        insertPublishedVersion: (input) =>
          Effect.sync(() => {
            minted += 1;
            return mintedFrom(input);
          }),
      });

      const failure = yield* publishWorkflow({
        workflowId: "wf_1",
        graph: createSerializedWorkflowGraph({
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
            {
              id: "action-1",
              type: "action",
              position: { x: 200, y: 0 },
              data: { label: "Notify", type: "action", config: {} },
            },
          ],
          edges: [
            {
              id: "e1",
              source: "lifecycle-1",
              target: "action-1",
              sourceHandle: "started",
            },
          ],
        }),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            repo,
            SilentAppLoggerLayer,
            catalogLayer,
            stubIntegrationRepo({ typesByIds: () => Effect.succeed({}) })
          )
        ),
        Effect.flip
      );

      assert.instanceOf(failure, InvalidInput);
      assert.isTrue(failure.error.includes("no action selected"));
      assert.strictEqual(minted, 0);
    })
  );
});
