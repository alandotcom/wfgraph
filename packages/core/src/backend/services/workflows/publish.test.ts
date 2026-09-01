import { assert, describe, it as standalone, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type {
  PublishedWorkflowVersion,
  Workflow,
} from "#src/backend/lib/db/schema";
import {
  InvalidInput,
  PublicationConflict,
} from "#src/backend/lib/effect/failures";
import {
  SilentAppLoggerLayer,
  stubExtensionCatalog,
  stubIntegrationRepo,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import { publishWorkflow } from "#src/backend/services/workflows/publish";
import type { WorkflowRepo } from "#src/backend/services/workflows/repo/index";
import { catalogFingerprint } from "#src/backend/services/workflows/version-digest";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { LifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { PUBLICATION_CONFLICT_CODES } from "@wfgraph/shared/rpc/error-codes";

const catalog = {
  events: [
    {
      name: "app/appointment.created",
      label: "Appointment created",
      correlationPath: "appointment.id",
      payloadFields: [],
    },
  ],
  actions: [
    {
      id: "custom/send",
      label: "Send",
      description: "Sends a message",
      category: "Custom",
      configFields: [],
      outputFields: [],
    },
  ],
  integrations: [],
};

const catalogLayer = stubExtensionCatalog(catalog);

function graphWith(rules: LifecycleRules, label = "Start"): Workflow["graph"] {
  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: "lifecycle-1",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: {
          label,
          type: "lifecycle",
          config: { lifecycleRules: rules },
        },
      },
    ],
    edges: [],
  });
}

function graphWithAction(edgeId: string): Workflow["graph"] {
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
      {
        id: "action-1",
        type: "action",
        position: { x: 200, y: 0 },
        data: {
          label: "Send",
          type: "action",
          config: { actionType: "custom/send" },
        },
      },
    ],
    edges: [
      {
        id: edgeId,
        source: "lifecycle-1",
        target: "action-1",
        sourceHandle: "started",
      },
    ],
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
): { workflow: Workflow; version: PublishedWorkflowVersion } {
  const version: PublishedWorkflowVersion = {
    id: input.versionId,
    workflowId: input.workflowId,
    version: input.version,
    kind: "published",
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
          findPublishedVersion: () => Effect.succeed(null),
          findLatestVersion: () => Effect.succeed(null),
          insertPublishedVersion: (input) =>
            Effect.sync(() => {
              inserted.push(input);
              return mintedFrom(input);
            }),
        });

        const result = yield* publishWorkflow({
          workflowId: "wf_1",
          graph: draft.graph,
          expectedPublishedVersionId: null,
        }).pipe(Effect.provide(repo));

        assert.strictEqual(result.publishedVersion, 1);
        assert.strictEqual(result.hasUnpublishedChanges, false);
        assert.strictEqual(inserted.length, 1);
        assert.strictEqual(inserted[0]?.version, 1);
        assert.strictEqual(inserted[0]?.expectedPublishedVersionId, null);
        assert.ok(inserted[0]?.eventSubscriptions.length === 1);
        assert.strictEqual(
          inserted[0]?.eventSubscriptions[0]?.eventName,
          "app/appointment.created"
        );
      })
    );

    it.effect(
      "refuses a graph change when publication moves during preflight",
      () =>
        Effect.gen(function* () {
          const current: PublishedWorkflowVersion = {
            id: "ver_8",
            workflowId: "wf_1",
            version: 8,
            kind: "published",
            graph: draft.graph,
            catalogFingerprint: catalogFingerprint(catalog),
            graphDigest: "current-graph",
            publishedAt: new Date("2026-08-03T00:00:00.000Z"),
          };
          const repo = stubWorkflowRepo({
            findById: () =>
              Effect.succeed({ ...draft, publishedVersionId: "ver_7" }),
            findPublishedVersion: () => Effect.succeed(current),
            findLatestVersion: () => Effect.succeed(current),
            insertPublishedVersion: (input) =>
              Effect.succeed(mintedFrom(input)),
          });

          const failure = yield* publishWorkflow({
            workflowId: "wf_1",
            graph: graphWith(rules, "Changed after review"),
            expectedPublishedVersionId: "ver_7",
          }).pipe(Effect.provide(repo), Effect.flip);

          assert.instanceOf(failure, PublicationConflict);
          assert.deepStrictEqual(failure.payload, {
            error:
              "This workflow was published elsewhere. Refresh and try again.",
            code: PUBLICATION_CONFLICT_CODES.stale,
          });
        })
    );

    it.effect("mints a new chronological version when content repeats", () =>
      Effect.gen(function* () {
        let workflow = draft;
        const versions: PublishedWorkflowVersion[] = [];
        const repo = stubWorkflowRepo({
          findById: () => Effect.succeed(workflow),
          findPublishedVersion: () =>
            Effect.succeed(
              versions.find(
                (version) => version.id === workflow.publishedVersionId
              ) ?? null
            ),
          findLatestVersion: () => Effect.succeed(versions.at(-1) ?? null),
          insertPublishedVersion: (input) =>
            Effect.sync(() => {
              const minted = mintedFrom(input);
              versions.push(minted.version);
              workflow = minted.workflow;
              return minted;
            }),
        });

        yield* publishWorkflow({
          workflowId: "wf_1",
          graph: draft.graph,
          expectedPublishedVersionId: null,
        }).pipe(Effect.provide(repo));
        yield* publishWorkflow({
          workflowId: "wf_1",
          graph: graphWith(rules, "Changed"),
          expectedPublishedVersionId: workflow.publishedVersionId,
        }).pipe(Effect.provide(repo));
        yield* publishWorkflow({
          workflowId: "wf_1",
          graph: draft.graph,
          expectedPublishedVersionId: workflow.publishedVersionId,
        }).pipe(Effect.provide(repo));

        assert.deepStrictEqual(
          versions.map((version) => version.version),
          [1, 2, 3]
        );
        assert.strictEqual(versions[0]?.graphDigest, versions[2]?.graphDigest);
      })
    );

    it.effect(
      "refuses a semantically identical graph with a legacy digest",
      () =>
        Effect.gen(function* () {
          const current: PublishedWorkflowVersion = {
            id: "ver_1",
            workflowId: "wf_1",
            version: 1,
            kind: "published",
            graph: draft.graph,
            graphDigest: "legacy-full-graph-digest",
            catalogFingerprint: "previous-catalog",
            publishedAt: new Date("2026-08-01T00:00:00.000Z"),
          };
          const repo = stubWorkflowRepo({
            findById: () =>
              Effect.succeed({ ...draft, publishedVersionId: current.id }),
            findPublishedVersion: () => Effect.succeed(current),
          });

          const failure = yield* publishWorkflow({
            workflowId: "wf_1",
            graph: draft.graph,
            expectedPublishedVersionId: current.id,
          }).pipe(Effect.provide(repo), Effect.flip);

          assert.instanceOf(failure, PublicationConflict);
          assert.deepStrictEqual(failure.payload, {
            error: "This workflow graph is already published.",
            code: PUBLICATION_CONFLICT_CODES.alreadyPublished,
          });
        })
    );

    it.effect(
      "refuses geometry-only edits regardless of catalog fingerprint",
      () =>
        Effect.gen(function* () {
          const current: PublishedWorkflowVersion = {
            id: "ver_1",
            workflowId: "wf_1",
            version: 1,
            kind: "published",
            graph: draft.graph,
            graphDigest: "legacy-full-graph-digest",
            catalogFingerprint: "previous-catalog",
            publishedAt: new Date("2026-08-01T00:00:00.000Z"),
          };
          const repo = stubWorkflowRepo({
            findById: () =>
              Effect.succeed({ ...draft, publishedVersionId: current.id }),
            findPublishedVersion: () => Effect.succeed(current),
          });

          const moved = {
            ...draft.graph,
            nodes: draft.graph.nodes.map((node) => ({
              ...node,
              attributes: {
                ...node.attributes,
                position: { x: 500, y: 700 },
                width: 400,
                height: 240,
              },
            })),
          };

          const failure = yield* publishWorkflow({
            workflowId: "wf_1",
            graph: moved,
            expectedPublishedVersionId: current.id,
          }).pipe(Effect.provide(repo), Effect.flip);

          assert.instanceOf(failure, PublicationConflict);
          assert.strictEqual(
            failure.payload.code,
            PUBLICATION_CONFLICT_CODES.alreadyPublished
          );
        })
    );

    it.effect("refuses an edge-id-only edit", () =>
      Effect.gen(function* () {
        const publishedGraph = graphWithAction("edge-old");
        const current: PublishedWorkflowVersion = {
          id: "ver_1",
          workflowId: "wf_1",
          version: 1,
          kind: "published",
          graph: publishedGraph,
          graphDigest: "legacy-full-graph-digest",
          catalogFingerprint: catalogFingerprint(catalog),
          publishedAt: new Date("2026-08-01T00:00:00.000Z"),
        };
        const repo = stubWorkflowRepo({
          findById: () =>
            Effect.succeed({
              ...draft,
              graph: publishedGraph,
              publishedVersionId: current.id,
            }),
          findPublishedVersion: () => Effect.succeed(current),
        });

        const failure = yield* publishWorkflow({
          workflowId: "wf_1",
          graph: graphWithAction("edge-new"),
          expectedPublishedVersionId: current.id,
        }).pipe(Effect.provide(repo), Effect.flip);

        assert.instanceOf(failure, PublicationConflict);
        assert.strictEqual(
          failure.payload.code,
          PUBLICATION_CONFLICT_CODES.alreadyPublished
        );
      })
    );

    it.effect("mints the next version for a semantic graph change", () =>
      Effect.gen(function* () {
        const expectedPointers: Array<string | null> = [];
        const current: PublishedWorkflowVersion = {
          id: "ver_1",
          workflowId: "wf_1",
          version: 1,
          kind: "published",
          graph: draft.graph,
          graphDigest: "legacy-full-graph-digest",
          catalogFingerprint: catalogFingerprint(catalog),
          publishedAt: new Date("2026-08-01T00:00:00.000Z"),
        };
        const repo = stubWorkflowRepo({
          findById: () =>
            Effect.succeed({ ...draft, publishedVersionId: current.id }),
          findPublishedVersion: () => Effect.succeed(current),
          findLatestVersion: () => Effect.succeed(current),
          insertPublishedVersion: (input) =>
            Effect.sync(() => {
              expectedPointers.push(input.expectedPublishedVersionId);
              return mintedFrom(input);
            }),
        });

        const result = yield* publishWorkflow({
          workflowId: "wf_1",
          graph: graphWith(rules, "Changed"),
          expectedPublishedVersionId: current.id,
        }).pipe(Effect.provide(repo));

        assert.strictEqual(result.publishedVersion, 2);
        assert.strictEqual(expectedPointers[0], current.id);
      })
    );

    it.effect("answers Conflict when the version claim is stale", () =>
      Effect.gen(function* () {
        const repo = stubWorkflowRepo({
          findById: () => Effect.succeed(draft),
          findPublishedVersion: () => Effect.succeed(null),
          findLatestVersion: () =>
            Effect.succeed({
              id: "ver_1",
              workflowId: "wf_1",
              version: 2,
              kind: "published",
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
          expectedPublishedVersionId: null,
        }).pipe(Effect.provide(repo), Effect.flip);

        assert.instanceOf(failure, PublicationConflict);
        assert.strictEqual(
          failure.payload.code,
          PUBLICATION_CONFLICT_CODES.stale
        );
        assert.ok(
          failure.error.includes("Refresh"),
          `expected refresh guidance, got: ${failure.error}`
        );
      })
    );
  });

  /** A half-built graph stops before any version row is minted. */
  standalone.effect("refuses a half-built graph and mints nothing", () =>
    Effect.gen(function* () {
      let minted = 0;
      const repo = stubWorkflowRepo({
        findById: () => Effect.succeed(draft),
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
        expectedPublishedVersionId: null,
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
