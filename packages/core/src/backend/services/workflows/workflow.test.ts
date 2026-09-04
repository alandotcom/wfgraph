import { assert, describe, it as effectIt, layer } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import type { Workflow } from "#src/backend/lib/db/schema";
import { DraftConflict, NotFound } from "#src/backend/lib/effect/failures";
import {
  SilentAppLoggerLayer,
  stubExtensionCatalog,
  stubIntegrationRepo,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import {
  getWorkflowDraftRevision,
  patchWorkflow,
  streamWorkflowDraftRevisions,
} from "#src/backend/services/workflows/workflow";
import { postWorkflowsCurrent } from "#src/backend/services/workflows/current";
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
    {
      name: "app/appointment.canceled",
      label: "Appointment canceled",
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

const startAndCancel: LifecycleRules = {
  startEvents: ["app/appointment.created"],
  cancelEvents: ["app/appointment.canceled"],
  concurrency: "newest-wins",
};

const stored: Workflow = {
  id: "wf_1",
  name: "Appointment Reminders",
  description: null,
  graph: graphWith(startAndCancel),
  draftRevision: 1,
  isPaused: false,
  mode: "live",
  visibility: "private",
  publishedVersionId: null,
  createdAt: new Date("2026-03-01T00:00:00.000Z"),
  updatedAt: new Date("2026-03-01T00:00:00.000Z"),
};

describe("getWorkflowDraftRevision", () => {
  effectIt.effect(
    "returns the persisted draft revision without loading the graph",
    () =>
      Effect.gen(function* () {
        const result = yield* getWorkflowDraftRevision("wf_1").pipe(
          Effect.provide(
            Layer.mergeAll(
              SilentAppLoggerLayer,
              stubWorkflowRepo({
                findDraftRevisionById: () =>
                  Effect.succeed({ id: "wf_1", draftRevision: 7 }),
              })
            )
          )
        );

        assert.deepStrictEqual(result, {
          workflowId: "wf_1",
          draftRevision: 7,
        });
      })
  );

  effectIt.effect("fails when the workflow does not exist", () =>
    Effect.gen(function* () {
      const failure = yield* getWorkflowDraftRevision("missing").pipe(
        Effect.provide(
          Layer.mergeAll(
            SilentAppLoggerLayer,
            stubWorkflowRepo({
              findDraftRevisionById: () => Effect.succeed(null),
            })
          )
        ),
        Effect.flip
      );

      assert.instanceOf(failure, NotFound);
    })
  );
});

describe("streamWorkflowDraftRevisions", () => {
  effectIt.live("emits only revisions newer than the connected client", () =>
    Effect.gen(function* () {
      const revisions = [1, 1, 2, 2, 3];
      let read = 0;
      const events = yield* streamWorkflowDraftRevisions(
        {
          workflowId: "wf_1",
          afterDraftRevision: 1,
        },
        { pollIntervalMs: 1 }
      ).pipe(
        Effect.flatMap((stream) => Stream.runCollect(Stream.take(stream, 2))),
        Effect.provide(
          Layer.mergeAll(
            SilentAppLoggerLayer,
            stubWorkflowRepo({
              findDraftRevisionById: () =>
                Effect.succeed({
                  id: "wf_1",
                  draftRevision: revisions[read++] ?? 3,
                }),
            })
          )
        )
      );

      assert.deepStrictEqual(Array.from(events), [
        { workflowId: "wf_1", draftRevision: 2 },
        { workflowId: "wf_1", draftRevision: 3 },
      ]);
    })
  );
});

/** The repository, keeping what the update was written with. */
function makeRepo() {
  const draftWrites: Array<
    Parameters<WorkflowRepo["Service"]["writeDraft"]>[0]
  > = [];
  const metadataUpdates: Array<
    Parameters<WorkflowRepo["Service"]["updateMetadata"]>[0]
  > = [];

  return {
    draftWrites,
    metadataUpdates,
    layer: stubWorkflowRepo({
      findById: () => Effect.succeed(stored),
      hasOtherWithName: () => Effect.succeed(false),
      writeDraft: (input) =>
        Effect.sync(() => {
          draftWrites.push(input);
          return {
            status: "updated" as const,
            workflow: {
              ...stored,
              ...input.updates,
              draftRevision: stored.draftRevision + 1,
            },
          };
        }),
      updateMetadata: (input) =>
        Effect.sync(() => {
          metadataUpdates.push(input);
          return { ...stored, ...input.updates };
        }),
    }),
  };
}

describe("patchWorkflow", () => {
  layer(
    Layer.mergeAll(SilentAppLoggerLayer, catalogLayer, stubIntegrationRepo())
  )((it) => {
    // Draft saves keep the subscription index alone: only publish rewrites it
    // from the published graph, so a half-built canvas cannot start runs.
    it.effect("leaves the subscriptions alone on a graph write", () =>
      Effect.gen(function* () {
        const repo = makeRepo();

        yield* patchWorkflow("wf_1", {
          expectedDraftRevision: 1,
          graph: graphWith({
            startEvents: ["app/appointment.created"],
            cancelEvents: [],
            concurrency: "newest-wins",
          }),
        }).pipe(Effect.provide(repo.layer));

        assert.strictEqual(repo.draftWrites[0]?.expectedDraftRevision, 1);
      })
    );

    // A rename writes no graph, so the index derived from one stands: re-deriving
    // it would mean re-validating a stored graph a rename has no business
    // refusing.
    it.effect("leaves the subscriptions alone on a name-only update", () =>
      Effect.gen(function* () {
        const repo = makeRepo();

        yield* patchWorkflow("wf_1", { name: "Renamed" }).pipe(
          Effect.provide(repo.layer)
        );

        assert.strictEqual(repo.metadataUpdates[0]?.updates.name, "Renamed");
      })
    );

    it.effect("returns the current revision for a stale graph patch", () =>
      Effect.gen(function* () {
        const failure = yield* patchWorkflow("wf_1", {
          expectedDraftRevision: 1,
          graph: stored.graph,
        }).pipe(
          Effect.provide(
            stubWorkflowRepo({
              findById: () => Effect.succeed(stored),
              writeDraft: () =>
                Effect.succeed({
                  status: "conflict" as const,
                  currentDraftRevision: 2,
                }),
            })
          ),
          Effect.flip
        );

        assert.instanceOf(failure, DraftConflict);
        assert.strictEqual(failure.currentDraftRevision, 2);
      })
    );

    it.effect(
      "returns the current revision for a stale current-workflow save",
      () =>
        Effect.gen(function* () {
          const failure = yield* postWorkflowsCurrent({
            graph: stored.graph,
            expectedDraftRevision: 1,
          }).pipe(
            Effect.provide(
              stubWorkflowRepo({
                findCurrent: Effect.succeed(stored),
                writeDraft: () =>
                  Effect.succeed({
                    status: "conflict" as const,
                    currentDraftRevision: 2,
                  }),
              })
            ),
            Effect.flip
          );

          assert.instanceOf(failure, DraftConflict);
          assert.strictEqual(failure.currentDraftRevision, 2);
        })
    );
  });
});
