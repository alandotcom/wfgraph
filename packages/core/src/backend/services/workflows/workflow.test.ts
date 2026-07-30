import { assert, describe, layer } from "@effect/vitest";
// The lifecycle hooks come from vitest itself; `@effect/vitest` re-exports only
// the ones its own `layer` block owns.
import { beforeAll } from "vitest";
import { Effect } from "effect";
import type { Workflow } from "#src/backend/lib/db/schema";
import {
  configureTestExtensions,
  SilentAppLoggerLayer,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import { patchWorkflow } from "#src/backend/services/workflows/workflow";
import type { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { createSerializedWorkflowGraph } from "@rova/shared/workflow/graph";
import type { LifecycleRules } from "@rova/shared/workflow/lifecycle-rules";

beforeAll(() => {
  configureTestExtensions({
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
});

function graphWith(rules: LifecycleRules): Workflow["graph"] {
  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: "lifecycle-1",
        type: "trigger",
        position: { x: 0, y: 0 },
        data: {
          label: "Start",
          type: "trigger",
          config: { lifecycleRules: rules },
        },
      },
    ],
    edges: [],
  });
}

const twoStartEvents: LifecycleRules = {
  startEvents: ["app/appointment.created", "app/appointment.canceled"],
  cancelEvents: [],
  concurrency: "newest-wins",
};

const stored: Workflow = {
  id: "wf_1",
  name: "Appointment Reminders",
  description: null,
  graph: graphWith(twoStartEvents),
  isPaused: false,
  mode: "live",
  visibility: "private",
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
  layer(SilentAppLoggerLayer)((it) => {
    // The index is derived from the graph being written, so removing a Start Event
    // has to shrink it in the same call. A stale row would keep delivering an
    // Event the workflow no longer names.
    it.effect("rewrites the subscriptions a graph write changes", () =>
      Effect.gen(function* () {
        const repo = makeRepo();

        yield* patchWorkflow("wf_1", {
          graph: graphWith({
            startEvents: ["app/appointment.created"],
            cancelEvents: [],
            concurrency: "newest-wins",
          }),
        }).pipe(Effect.provide(repo.layer));

        assert.deepStrictEqual(repo.updates[0]?.eventSubscriptions, [
          {
            workflowId: "wf_1",
            eventName: "app/appointment.created",
            role: "start",
            correlationPath: null,
          },
        ]);
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
