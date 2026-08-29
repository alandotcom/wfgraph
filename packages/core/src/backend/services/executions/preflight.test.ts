/**
 * What a Draft run freezes into the version it pins to, and what it does not ask
 * about the workflow.
 *
 * The graph checks above this are memoized on the semantic digest, which is
 * blind to node positions, so the thing worth asserting here is that the
 * snapshot carries the workflow's own draft rather than whatever graph first
 * taught the memo those semantics.
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
import type { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";

type SnapshotInput = Parameters<
  WorkflowRepo["Service"]["freezeDraftSnapshot"]
>[0];

/**
 * The workflow is in Live Published mode, which this loader never reads: that
 * mode governs Events and runs of the published version, and a Draft run's
 * recipients are decided by the request in `postWorkflowExecute`.
 */
const workflow = {
  id: "wf_1",
  name: "Appointment Reminders",
  mode: "live" as const,
  isPaused: false,
};

/**
 * The same one-node graph at two heights. Layout is outside the semantic
 * projection, so both graphs share a digest and the second call is a memo hit.
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

/** The surface both calls share, so the second one reads the first's verdict. */
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
    "freezes the workflow's own draft rather than the graph the memo answered with",
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
        // The builder drags the node: same meaning, new layout, memo hit.
        yield* run(400);

        expect(snapshots).toHaveLength(2);
        expect(snapshotNodeY(snapshots[0])).toBe(0);
        expect(snapshotNodeY(snapshots[1])).toBe(400);
        // The digest describes the meaning, which neither drag moved.
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
