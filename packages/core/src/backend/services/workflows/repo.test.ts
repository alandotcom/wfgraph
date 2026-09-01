import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { stubDatabase } from "#src/backend/lib/effect/test-layers";
import {
  WorkflowRepo,
  WorkflowRepoLayer,
} from "#src/backend/services/workflows/repo/index";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";

describe("findByIdWithPublishedVersionForRun", () => {
  function findForRun(workflowId: string) {
    return Effect.gen(function* () {
      const repo = yield* WorkflowRepo;
      return yield* repo.findByIdWithPublishedVersionForRun(workflowId);
    });
  }

  it("selects the workflow fields the run needs and the version graph", async () => {
    const { layer: databaseLayer, statements } = stubDatabase(() => []);

    await Effect.runPromise(
      findForRun("wf_1").pipe(
        Effect.provide(WorkflowRepoLayer.pipe(Layer.provide(databaseLayer)))
      )
    );

    const query = statements[0]?.query ?? "";
    const outerSelect = query.slice(0, query.indexOf('from "workflows"'));
    expect(outerSelect).toContain('as "id"');
    expect(outerSelect).toContain('as "name"');
    expect(outerSelect).toContain('as "mode"');
    expect(outerSelect).toContain('as "isPaused"');
    expect(outerSelect).not.toContain("graph");
    expect(query).toContain('"graph" as "graph"');
  });
});

describe("findLatestVersion", () => {
  it("selects only the version number", async () => {
    const { layer: databaseLayer, statements } = stubDatabase(() => [[4]]);

    const found = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepo;
        return yield* repo.findLatestVersion("wf_1");
      }).pipe(
        Effect.provide(WorkflowRepoLayer.pipe(Layer.provide(databaseLayer)))
      )
    );

    const query = statements[0]?.query ?? "";
    expect(found).toEqual({ version: 4 });
    expect(query).toContain('select "version" from "workflow_versions"');
    expect(query).not.toContain("graph");
  });
});

describe("freezeDraftSnapshot", () => {
  const emptyGraph = createSerializedWorkflowGraph({ nodes: [], edges: [] });

  function insertSnapshot() {
    return Effect.gen(function* () {
      const repo = yield* WorkflowRepo;
      return yield* repo.freezeDraftSnapshot({
        workflowId: "wf_1",
        versionId: "ver_snapshot",
        graph: emptyGraph,
        catalogFingerprint: "fp",
        graphDigest: "digest",
      });
    });
  }

  const snapshotRow = (id: string) => [
    id,
    "wf_1",
    null,
    "draft_snapshot",
    JSON.stringify(emptyGraph),
    "fp",
    "digest",
    new Date(),
  ];

  // With no existing snapshot, the lookup returns nothing, so the insert runs
  // and returns the minted row.
  function run(existing: string | null = null) {
    const { layer: databaseLayer, statements } = stubDatabase((statement) =>
      statement.query.startsWith("select")
        ? existing
          ? [snapshotRow(existing)]
          : []
        : [snapshotRow("ver_snapshot")]
    );

    return {
      statements,
      snapshot: Effect.runPromise(
        insertSnapshot().pipe(
          Effect.provide(WorkflowRepoLayer.pipe(Layer.provide(databaseLayer)))
        )
      ),
    };
  }

  // The publication pointer and the Event subscription index both describe the
  // published graph. A snapshot that changed either one would let Events start
  // an unpublished graph.
  it("writes to the versions table only", async () => {
    const { statements, snapshot } = run();
    await snapshot;

    expect(statements).toHaveLength(2);
  });
});
