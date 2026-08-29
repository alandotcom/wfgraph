import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type {
  PublishedWorkflowVersion,
  Workflow,
} from "#src/backend/lib/db/schema";
import { NotFound } from "#src/backend/lib/effect/failures";
import {
  SilentAppLoggerLayer,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import {
  compareWorkflowVersion,
  getWorkflowVersionHistory,
  restoreWorkflowVersion,
} from "#src/backend/services/workflows/versions";
import type { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";

function graph(config: Record<string, unknown> = {}) {
  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: "lifecycle_1",
        type: "lifecycle",
        position: { x: -200, y: 0 },
        data: {
          label: "Start",
          type: "lifecycle",
          config: {
            lifecycleRules: {
              startEvents: [],
              cancelEvents: [],
              concurrency: "unlimited",
            },
          },
        },
      },
      {
        id: "action_1",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Send",
          type: "action",
          config: { actionType: "example/send", ...config },
        },
      },
    ],
    edges: [],
  });
}

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf_1",
    name: "Workflow",
    description: null,
    graph: graph({ message: "saved draft" }),
    isPaused: false,
    mode: "live",
    visibility: "private",
    publishedVersionId: "ver_current",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-02T00:00:00.000Z"),
    ...overrides,
  };
}

function version(
  overrides: Partial<PublishedWorkflowVersion> = {}
): PublishedWorkflowVersion {
  return {
    id: "ver_1",
    workflowId: "wf_1",
    version: 1,
    kind: "published",
    graph: graph({ message: "published" }),
    catalogFingerprint: "catalog",
    graphDigest: "digest",
    publishedAt: new Date("2026-08-03T00:00:00.000Z"),
    ...overrides,
  };
}

describe("workflow versions", () => {
  layer(Layer.mergeAll(SilentAppLoggerLayer))((it) => {
    it.effect(
      "returns a newest-first page using the default limit and an exclusive cursor",
      () =>
        Effect.gen(function* () {
          const calls: Array<
            Parameters<WorkflowRepo["Service"]["listVersionHistoryPage"]>[0]
          > = [];
          const rows = Array.from({ length: 26 }, (_, index) => ({
            id: `ver_${100 - index}`,
            version: 100 - index,
            publishedAt: new Date(
              `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`
            ),
            isCurrent: index === 0,
          }));
          const result = yield* getWorkflowVersionHistory({
            workflowId: "wf_1",
          }).pipe(
            Effect.provide(
              stubWorkflowRepo({
                existsById: () => Effect.succeed(true),
                listVersionHistoryPage: (input) =>
                  Effect.sync(() => {
                    calls.push(input);
                    return rows;
                  }),
              })
            )
          );

          assert.strictEqual(calls[0]?.limit, 25);
          assert.strictEqual(result.items.length, 25);
          assert.strictEqual(result.items[0]?.version, 100);
          assert.strictEqual(result.items[0]?.isCurrent, true);
          assert.deepStrictEqual(result.nextCursor, { version: 76 });
        })
    );

    it.effect(
      "keeps an explicit cursor and omits a cursor at the final boundary",
      () =>
        Effect.gen(function* () {
          const result = yield* getWorkflowVersionHistory({
            workflowId: "wf_1",
            limit: 2,
            cursor: { version: 8 },
          }).pipe(
            Effect.provide(
              stubWorkflowRepo({
                existsById: () => Effect.succeed(true),
                listVersionHistoryPage: (input) => {
                  assert.deepStrictEqual(input, {
                    workflowId: "wf_1",
                    limit: 2,
                    cursor: { version: 8 },
                  });
                  return Effect.succeed([
                    {
                      id: "ver_7",
                      version: 7,
                      publishedAt: new Date("2026-08-07T00:00:00.000Z"),
                      isCurrent: false,
                    },
                    {
                      id: "ver_6",
                      version: 6,
                      publishedAt: new Date("2026-08-06T00:00:00.000Z"),
                      isCurrent: false,
                    },
                  ]);
                },
              })
            )
          );

          assert.strictEqual(result.nextCursor, null);
          assert.strictEqual(
            result.items[0]?.publishedAt,
            "2026-08-07T00:00:00.000Z"
          );
        })
    );

    it.effect("refuses history for an absent workflow", () =>
      Effect.gen(function* () {
        const failure = yield* getWorkflowVersionHistory({
          workflowId: "wf_missing",
        }).pipe(
          Effect.provide(
            stubWorkflowRepo({ existsById: () => Effect.succeed(false) })
          ),
          Effect.flip
        );

        assert.instanceOf(failure, NotFound);
        assert.strictEqual(failure.error, "Workflow not found");
      })
    );

    it.effect(
      "compares the request draft and redacts changed sensitive fields",
      () =>
        Effect.gen(function* () {
          const base = version({
            graph: graph({
              apiKey: "old-secret",
              message: "base",
              optional: null,
            }),
          });
          const requestedDraft = graph({
            apiKey: "new-secret",
            message: "request draft",
            optional: "set",
          });
          const result = yield* compareWorkflowVersion({
            workflowId: "wf_1",
            baseVersionId: base.id,
            draftGraph: requestedDraft,
          }).pipe(
            Effect.provide(
              stubWorkflowRepo({
                findById: () =>
                  Effect.succeed(workflow({ publishedVersionId: base.id })),
                findVersionById: () => Effect.succeed(base),
                findLatestVersion: () =>
                  Effect.succeed(version({ version: 4 })),
              })
            )
          );

          assert.strictEqual(result.proposedVersion, 5);
          assert.isNotNull(result.baseVersion);
          assert.strictEqual(result.baseVersion.isCurrent, true);
          assert.include(JSON.stringify(result.draftGraph), "request draft");
          const sensitive = result.nodeChanges[0]?.fields.find(
            (field) => field.path.at(-1) === "apiKey"
          );
          assert.deepStrictEqual(sensitive, {
            path: ["data", "config", "apiKey"],
            kind: "modified",
            before: "******cret",
            after: "******cret",
          });
          assert.notInclude(JSON.stringify(result), "old-secret");
          assert.notInclude(JSON.stringify(result), "new-secret");
          const nullable = result.nodeChanges[0]?.fields.find(
            (field) => field.path.at(-1) === "optional"
          );
          assert.deepStrictEqual(nullable, {
            path: ["data", "config", "optional"],
            kind: "modified",
            before: null,
            after: "set",
          });
        })
    );

    it.effect(
      "redacts changed fields when a sensitive ancestor owns the path",
      () =>
        Effect.gen(function* () {
          const base = version({
            graph: graph({
              credentials: { value: "old-credential" },
              auth: { username: "old-user" },
            }),
          });
          const requestedDraft = graph({
            credentials: { value: "new-credential" },
            auth: { username: "new-user" },
          });
          const result = yield* compareWorkflowVersion({
            workflowId: "wf_1",
            baseVersionId: base.id,
            draftGraph: requestedDraft,
          }).pipe(
            Effect.provide(
              stubWorkflowRepo({
                findById: () => Effect.succeed(workflow()),
                findVersionById: () => Effect.succeed(base),
                findLatestVersion: () => Effect.succeed(base),
              })
            )
          );

          const fields = result.nodeChanges[0]?.fields ?? [];
          assert.deepStrictEqual(
            fields.filter((field) =>
              ["credentials", "auth"].includes(field.path[2] ?? "")
            ),
            [
              {
                path: ["data", "config", "auth", "username"],
                kind: "modified",
                before: "[REDACTED]",
                after: "[REDACTED]",
              },
              {
                path: ["data", "config", "credentials", "value"],
                kind: "modified",
                before: "[REDACTED]",
                after: "[REDACTED]",
              },
            ]
          );
          assert.notInclude(JSON.stringify(result), "old-credential");
          assert.notInclude(JSON.stringify(result), "new-credential");
          assert.notInclude(JSON.stringify(result), "old-user");
          assert.notInclude(JSON.stringify(result), "new-user");
        })
    );

    it.effect("does not report equal secrets or position-only changes", () =>
      Effect.gen(function* () {
        const base = version({ graph: graph({ apiKey: "same-secret" }) });
        const draft = {
          ...base.graph,
          nodes: base.graph.nodes.map((node) => ({
            ...node,
            attributes: { ...node.attributes, position: { x: 999, y: 999 } },
          })),
        };
        const result = yield* compareWorkflowVersion({
          workflowId: "wf_1",
          baseVersionId: base.id,
          draftGraph: draft,
        }).pipe(
          Effect.provide(
            stubWorkflowRepo({
              findById: () => Effect.succeed(workflow()),
              findVersionById: () => Effect.succeed(base),
              findLatestVersion: () => Effect.succeed(base),
            })
          )
        );

        assert.strictEqual(result.hasChanges, false);
        assert.deepStrictEqual(result.nodeChanges, []);
      })
    );

    it.effect("compares a first publication with an empty graph", () =>
      Effect.gen(function* () {
        const draft = graph({ message: "first publication" });
        const result = yield* compareWorkflowVersion({
          workflowId: "wf_1",
          draftGraph: draft,
        }).pipe(
          Effect.provide(
            stubWorkflowRepo({
              findById: () =>
                Effect.succeed(workflow({ publishedVersionId: null })),
              findLatestVersion: () => Effect.succeed(null),
            })
          )
        );

        assert.strictEqual(result.baseVersion, null);
        assert.strictEqual(result.baseGraph.nodes.length, 0);
        assert.strictEqual(result.proposedVersion, 1);
        assert.strictEqual(result.hasChanges, true);
        assert.deepStrictEqual(
          result.nodeChanges.map(({ nodeId, kind }) => ({ nodeId, kind })),
          [
            { nodeId: "action_1", kind: "added" },
            { nodeId: "lifecycle_1", kind: "added" },
          ]
        );
      })
    );

    // A snapshot is minted by a test-mode draft run, never by a Publish, so it
    // is not one of the versions the history offers to compare against.
    it.effect("conceals a draft snapshot", () =>
      Effect.gen(function* () {
        const snapshot = {
          ...version(),
          version: null,
          kind: "draft_snapshot" as const,
        };
        const failure = yield* compareWorkflowVersion({
          workflowId: "wf_1",
          baseVersionId: snapshot.id,
          draftGraph: graph(),
        }).pipe(
          Effect.provide(
            stubWorkflowRepo({
              findById: () => Effect.succeed(workflow()),
              findVersionById: () => Effect.succeed(snapshot),
            })
          ),
          Effect.flip
        );

        assert.instanceOf(failure, NotFound);
        assert.strictEqual(failure.error, "Workflow version not found");
      })
    );

    it.effect("conceals a version owned by another workflow", () =>
      Effect.gen(function* () {
        const foreign = version({ workflowId: "wf_other" });
        const failure = yield* compareWorkflowVersion({
          workflowId: "wf_1",
          baseVersionId: foreign.id,
          draftGraph: graph(),
        }).pipe(
          Effect.provide(
            stubWorkflowRepo({
              findById: () => Effect.succeed(workflow()),
              findVersionById: () => Effect.succeed(foreign),
            })
          ),
          Effect.flip
        );

        assert.instanceOf(failure, NotFound);
        assert.strictEqual(failure.error, "Workflow version not found");
      })
    );

    it.effect(
      "restores a version as the draft while preserving publication and subscriptions",
      () =>
        Effect.gen(function* () {
          const restored = version({
            id: "ver_restore",
            version: 1,
            kind: "published",
            graph: graph({ message: "restore me" }),
          });
          const current = version({
            id: "ver_current",
            version: 4,
            publishedAt: new Date("2026-08-04T00:00:00.000Z"),
          });
          const updates: Array<
            Parameters<WorkflowRepo["Service"]["update"]>[0]
          > = [];
          const result = yield* restoreWorkflowVersion({
            workflowId: "wf_1",
            versionId: restored.id,
          }).pipe(
            Effect.provide(
              stubWorkflowRepo({
                findById: () => Effect.succeed(workflow()),
                findVersionById: (versionId) =>
                  Effect.succeed(
                    versionId === restored.id ? restored : current
                  ),
                update: (input) =>
                  Effect.sync(() => {
                    updates.push(input);
                    return {
                      ...workflow(),
                      graph: input.updates.graph ?? workflow().graph,
                    };
                  }),
              })
            )
          );

          assert.deepStrictEqual(updates[0]?.updates.graph, restored.graph);
          assert.strictEqual(updates[0]?.eventSubscriptions, "unchanged");
          assert.strictEqual(result.publishedVersionId, "ver_current");
          assert.strictEqual(result.publishedVersion, 4);
          assert.strictEqual(result.publishedAt, "2026-08-04T00:00:00.000Z");
        })
    );

    it.effect("conceals a foreign version from restore", () =>
      Effect.gen(function* () {
        const failure = yield* restoreWorkflowVersion({
          workflowId: "wf_1",
          versionId: "ver_foreign",
        }).pipe(
          Effect.provide(
            stubWorkflowRepo({
              findById: () => Effect.succeed(workflow()),
              findVersionById: () =>
                Effect.succeed(version({ workflowId: "wf_other" })),
            })
          ),
          Effect.flip
        );

        assert.instanceOf(failure, NotFound);
        assert.strictEqual(failure.error, "Workflow version not found");
      })
    );
  });
});
