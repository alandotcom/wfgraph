// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type { Workflow } from "#src/backend/lib/db/schema";
import { Conflict } from "#src/backend/lib/effect/failures";
import {
  SilentAppLoggerLayer,
  stubExtensionCatalog,
  stubIntegrationRepo,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import { postWorkflowDuplicate } from "#src/backend/services/workflows/duplicate";
import type { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { createSerializedWorkflowGraph } from "@rova/shared/graph/graph";

const sourceGraph = createSerializedWorkflowGraph({
  nodes: [
    {
      id: "lifecycle-1",
      type: "lifecycle",
      position: { x: 0, y: 0 },
      data: {
        label: "Appointment",
        type: "lifecycle",
        config: {
          lifecycleRules: {
            startEvents: ["app/appointment.created"],
            cancelEvents: [],
            concurrency: "newest-wins",
          },
        },
      },
    },
    {
      id: "action-1",
      type: "action",
      position: { x: 200, y: 0 },
      data: {
        label: "Send email",
        type: "action",
        status: "success",
        config: { actionId: "resend/send-email", integrationId: "int_live" },
      },
    },
  ],
  edges: [],
});

const sourceWorkflow: Workflow = {
  id: "wf_source",
  name: "Appointment Reminders",
  description: "the original",
  graph: sourceGraph,
  isPaused: false,
  mode: "test",
  visibility: "public",
  createdAt: new Date("2026-02-01T00:00:00.000Z"),
  updatedAt: new Date("2026-02-02T00:00:00.000Z"),
};

/**
 * A repository holding one workflow to copy, and keeping whatever the copy was
 * written with.
 *
 * The stored row is what the assertions read: duplication's whole job is
 * deciding what the new row's graph, name, and mode are, and the repository is
 * where that decision becomes visible. Built per test rather than reset between
 * them, so no test can see what another one wrote.
 */
function makeWorkflowRepo(options?: { nameTaken?: boolean }) {
  const calls = {
    inserts: [] as Array<Parameters<WorkflowRepo["Service"]["insert"]>[0]>,
  };

  // Duplication reads one workflow and writes one; everything else refuses.
  const repoLayer = stubWorkflowRepo({
    findById: (workflowId) =>
      Effect.succeed(workflowId === sourceWorkflow.id ? sourceWorkflow : null),
    hasWithName: () => Effect.succeed(options?.nameTaken === true),
    insert: (input) =>
      Effect.sync(() => {
        calls.inserts.push(input);
        return {
          ...sourceWorkflow,
          id: input.id,
          name: input.name,
          description: input.description ?? null,
          graph: input.graph,
          mode: input.mode ?? "live",
          visibility: input.visibility ?? "private",
        };
      }),
  });

  return { layer: repoLayer, calls };
}

function nodeConfig(
  graph: { nodes: Array<{ attributes: { data: { config?: unknown } } }> },
  index: number
): Record<string, unknown> | undefined {
  const config = graph.nodes[index]?.attributes.data.config;
  return typeof config === "object" && config !== null
    ? { ...config }
    : undefined;
}

// Every save checks its Lifecycle Rules against the catalog, and a copy is a
// save: this is the surface those rules are checked against.
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

describe("postWorkflowDuplicate", () => {
  layer(
    Layer.mergeAll(SilentAppLoggerLayer, catalogLayer, stubIntegrationRepo())
  )((it) => {
    it.effect("drops the integration key instead of emptying it", () =>
      Effect.gen(function* () {
        const repo = makeWorkflowRepo();

        yield* postWorkflowDuplicate("wf_source").pipe(
          Effect.provide(repo.layer)
        );

        const storedGraph = repo.calls.inserts[0]?.graph;
        assert.isDefined(storedGraph);
        // The entry node's config travels whole, Lifecycle Rules included: the
        // copy starts on the same Event as its source.
        assert.deepStrictEqual(nodeConfig(storedGraph, 0), {
          lifecycleRules: {
            startEvents: ["app/appointment.created"],
            cancelEvents: [],
            concurrency: "newest-wins",
          },
        });
        assert.deepStrictEqual(nodeConfig(storedGraph, 1), {
          actionId: "resend/send-email",
        });
      })
    );

    it.effect("keeps the source's mode and makes the copy private", () =>
      Effect.gen(function* () {
        const repo = makeWorkflowRepo();

        const copy = yield* postWorkflowDuplicate("wf_source").pipe(
          Effect.provide(repo.layer)
        );

        assert.strictEqual(copy.name, "Appointment Reminders (Copy)");
        assert.strictEqual(copy.mode, "test");
        assert.strictEqual(copy.visibility, "private");
      })
    );

    it.effect("gives every copied node a fresh id and an idle status", () =>
      Effect.gen(function* () {
        const repo = makeWorkflowRepo();

        yield* postWorkflowDuplicate("wf_source").pipe(
          Effect.provide(repo.layer)
        );

        const storedGraph = repo.calls.inserts[0]?.graph;
        assert.isDefined(storedGraph);
        const copiedIds = storedGraph.nodes.map((node) => node.key);
        assert.notInclude(copiedIds, "lifecycle-1");
        assert.notInclude(copiedIds, "action-1");
        for (const node of storedGraph.nodes) {
          assert.strictEqual(node.attributes.data.status, "idle");
        }
      })
    );

    it.effect("refuses when the copy's name is already taken", () =>
      Effect.gen(function* () {
        const repo = makeWorkflowRepo({ nameTaken: true });

        const failure = yield* postWorkflowDuplicate("wf_source").pipe(
          Effect.provide(repo.layer),
          Effect.flip
        );

        assert.instanceOf(failure, Conflict);
        assert.strictEqual(
          failure.error,
          'Workflow name "Appointment Reminders (Copy)" already exists'
        );
        assert.deepStrictEqual(repo.calls.inserts, []);
      })
    );
  });

  // A copy names the same Start Event as its source, so it subscribes to it
  // from the moment it exists -- under its own id, and paused, because two
  // unpaused workflows on one Event would double every run.
  layer(
    Layer.mergeAll(SilentAppLoggerLayer, catalogLayer, stubIntegrationRepo())
  )((it) => {
    it.effect("derives the copy's own subscriptions and pauses it", () =>
      Effect.gen(function* () {
        const repo = makeWorkflowRepo();

        yield* postWorkflowDuplicate(sourceWorkflow.id).pipe(
          Effect.provide(repo.layer)
        );

        const insert = repo.calls.inserts[0];
        assert.isDefined(insert);
        assert.strictEqual(insert.isPaused, true);
        assert.deepStrictEqual(insert.eventSubscriptions, [
          {
            workflowId: insert.id,
            eventName: "app/appointment.created",
            role: "start",
            correlationPath: null,
          },
        ]);
        assert.notStrictEqual(insert.id, sourceWorkflow.id);
      })
    );
  });
});
