/**
 * Tests what a Draft run freezes into the version it pins to.
 *
 * The graph checks above this loader are memoized on the semantic digest, which
 * ignores node positions. These tests assert that the snapshot stores the
 * workflow's own draft graph, even when the memo returns an earlier graph with
 * the same semantics.
 */

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  SilentAppLoggerLayer,
  stubExtensionCatalog,
  stubIntegrationRepo,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import { loadDraftForRun } from "#src/backend/services/executions/preflight";
import type { WorkflowRepo } from "#src/backend/services/workflows/repo/index";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";

type SnapshotInput = Parameters<
  WorkflowRepo["Service"]["freezeDraftSnapshot"]
>[0];

/**
 * The workflow is in Live Published mode, which this loader never reads. That
 * mode governs Events and runs of the published version. A Draft run's
 * recipients come from the request in `postWorkflowExecute`.
 */
const workflow = {
  id: "wf_1",
  name: "Appointment Reminders",
  mode: "live" as const,
  isPaused: false,
};

/**
 * The same one-node graph at two heights. Layout sits outside the semantic
 * projection, so both graphs share a digest and the second call hits the memo.
 */
function draftGraphAt(y: number) {
  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: "lifecycle-1",
        type: "lifecycle",
        position: { x: 0, y },
        data: { label: "Appointment", type: "lifecycle", config: {} },
      },
    ],
    edges: [],
  });
}

/** The catalog both calls share, so the second call reads the memoized result. */
const catalogLayer = stubExtensionCatalog();

function draftRepoLayer(
  draftGraph: ReturnType<typeof draftGraphAt>,
  snapshots: SnapshotInput[]
) {
  return stubWorkflowRepo({
    findByIdWithDraftGraphForRun: () =>
      Effect.succeed({ workflow, draftGraph }),
    freezeDraftSnapshot: (input) =>
      Effect.sync(() => {
        snapshots.push(input);
        return {
          id: input.versionId,
          workflowId: input.workflowId,
          version: null,
          kind: "draft_snapshot" as const,
          graph: input.graph,
          catalogFingerprint: input.catalogFingerprint,
          graphDigest: input.graphDigest,
          publishedAt: new Date("2026-03-01T00:00:00.000Z"),
        };
      }),
  });
}

function snapshotNodeY(snapshot: SnapshotInput | undefined): unknown {
  return snapshot?.graph.nodes[0]?.attributes.position?.y;
}

describe("loadDraftForRun", () => {
  it.effect(
    "freezes the workflow's own draft graph even when the memo hits",
    () =>
      Effect.gen(function* () {
        const snapshots: SnapshotInput[] = [];
        const run = (y: number) =>
          loadDraftForRun(workflow.id).pipe(
            Effect.flatMap((loaded) => loaded.pinVersion),
            Effect.provide(
              Layer.mergeAll(
                SilentAppLoggerLayer,
                catalogLayer,
                stubIntegrationRepo(),
                draftRepoLayer(draftGraphAt(y), snapshots)
              )
            )
          );

        yield* run(0);
        // Moving the node changes the layout only, so this call hits the memo.
        yield* run(400);

        expect(snapshots).toHaveLength(2);
        expect(snapshotNodeY(snapshots[0])).toBe(0);
        expect(snapshotNodeY(snapshots[1])).toBe(400);
        // The digest covers semantics only, so the move leaves it unchanged.
        expect(snapshots[1]?.graphDigest).toBe(snapshots[0]?.graphDigest);
      })
  );

  it.effect("loads the draft of a workflow in Live Published mode", () =>
    Effect.gen(function* () {
      const snapshots: SnapshotInput[] = [];
      const loaded = yield* loadDraftForRun(workflow.id).pipe(
        Effect.tap((result) => result.pinVersion),
        Effect.provide(
          Layer.mergeAll(
            SilentAppLoggerLayer,
            stubExtensionCatalog(),
            stubIntegrationRepo(),
            draftRepoLayer(draftGraphAt(80), snapshots)
          )
        )
      );

      expect(loaded.workflow.mode).toBe("live");
      expect(snapshots).toHaveLength(1);
      expect(loaded.preflight.workflowVersionId).toBe(snapshots[0]?.versionId);
    })
  );
});
