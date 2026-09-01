import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type { Workflow } from "#src/backend/lib/db/schema";
import {
  SilentAppLoggerLayer,
  stubExtensionCatalog,
  stubIntegrationRepo,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import { patchWorkflow } from "#src/backend/services/workflows/workflow";
import type { WorkflowRepo } from "#src/backend/services/workflows/repo/index";
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
  isPaused: false,
  mode: "live",
  visibility: "private",
  publishedVersionId: null,
  createdAt: new Date("2026-03-01T00:00:00.000Z"),
  updatedAt: new Date("2026-03-01T00:00:00.000Z"),
};

/** The repository, keeping what the update was written with. */
function makeRepo() {
  const updates: Array<Parameters<WorkflowRepo["Service"]["update"]>[0]> = [];

  return {
    updates,
    layer: stubWorkflowRepo({
      findById: () => Effect.succeed(stored),
      hasOtherWithName: () => Effect.succeed(false),
      update: (input) =>
        Effect.sync(() => {
          updates.push(input);
          return { ...stored, name: input.updates.name ?? stored.name };
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
          graph: graphWith({
            startEvents: ["app/appointment.created"],
            cancelEvents: [],
            concurrency: "newest-wins",
          }),
        }).pipe(Effect.provide(repo.layer));

        assert.strictEqual(repo.updates[0]?.eventSubscriptions, "unchanged");
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

        assert.strictEqual(repo.updates[0]?.eventSubscriptions, "unchanged");
      })
    );
  });
});
