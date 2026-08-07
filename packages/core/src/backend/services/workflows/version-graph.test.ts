// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type { WorkflowVersion } from "#src/backend/lib/db/schema";
import {
  SilentAppLoggerLayer,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import { getVersionGraph } from "#src/backend/services/workflows/version-graph";
import { createSerializedWorkflowGraph } from "@rova/shared/graph/graph";

function version(overrides: Partial<WorkflowVersion> = {}): WorkflowVersion {
  return {
    id: "ver_1",
    workflowId: "wf_1",
    version: 1,
    graph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
    catalogFingerprint: "fp_1",
    graphDigest: "digest_1",
    publishedAt: new Date("2026-03-01T10:00:00.000Z"),
    ...overrides,
  };
}

describe("getVersionGraph", () => {
  layer(SilentAppLoggerLayer)((it) => {
    it.effect("answers the pinned version's graph, redacted", () =>
      Effect.gen(function* () {
        const sensitiveGraph = createSerializedWorkflowGraph({
          nodes: [
            {
              id: "node_1",
              type: "action",
              position: { x: 0, y: 0 },
              data: {
                label: "Send email",
                type: "action",
                config: { apiKey: "sk_live_abcd1234" },
              },
            },
          ],
          edges: [],
        });

        const result = yield* getVersionGraph("ver_1").pipe(
          Effect.provide(
            Layer.mergeAll(
              SilentAppLoggerLayer,
              stubWorkflowRepo({
                findVersionById: () =>
                  Effect.succeed(version({ graph: sensitiveGraph })),
              })
            )
          )
        );

        const node = result.graph.nodes.find(
          (candidate) => candidate.key === "node_1"
        );
        assert.deepStrictEqual(node?.attributes.data.config, {
          apiKey: "********1234",
        });
      })
    );

    it.effect("answers not-found when the version is gone", () =>
      Effect.gen(function* () {
        const failure = yield* getVersionGraph("ver_gone").pipe(
          Effect.provide(
            Layer.mergeAll(
              SilentAppLoggerLayer,
              stubWorkflowRepo({
                findVersionById: () => Effect.succeed(null),
              })
            )
          ),
          Effect.flip
        );

        assert.strictEqual(failure._tag, "NotFound");
      })
    );
  });
});
