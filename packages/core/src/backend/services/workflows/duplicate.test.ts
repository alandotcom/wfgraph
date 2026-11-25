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
import {
  compileConditionModel,
  nodeOutputConditionPath,
  parseConditionModel,
  serializeConditionModel,
  type ConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import {
  createSerializedWorkflowGraph,
  toWorkflowGraphData,
} from "@wfgraph/shared/graph/graph";

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
        config: {
          actionType: "resend/send-email",
          integrationId: "int_live",
        },
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
  draftRevision: 1,
  isPaused: false,
  mode: "test",
  visibility: "public",
  publishedVersionId: null,
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
function makeWorkflowRepo(options?: {
  nameTaken?: boolean;
  source?: Workflow;
}) {
  const source = options?.source ?? sourceWorkflow;
  const calls = {
    inserts: [] as Array<Parameters<WorkflowRepo["Service"]["insert"]>[0]>,
  };

  // Duplication reads one workflow and writes one; everything else refuses.
  const repoLayer = stubWorkflowRepo({
    findById: (workflowId) =>
      Effect.succeed(workflowId === source.id ? source : null),
    hasWithName: () => Effect.succeed(options?.nameTaken === true),
    insert: (input) =>
      Effect.sync(() => {
        calls.inserts.push(input);
        return {
          ...source,
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

/**
 * A Condition reading the `status` output of `sourceNodeId` by name, stored as
 * the editor stores it: the structured model beside the expression compiled
 * from it.
 */
function conditionReading(sourceNodeId: string) {
  const field = nodeOutputConditionPath(sourceNodeId, "status");
  assert.isNotNull(field);
  const model: ConditionModel = {
    version: 2,
    groupLogic: "and",
    groups: [
      {
        id: "group",
        logic: "and",
        conditions: [
          {
            id: "rule",
            field,
            fieldType: "string",
            operator: "equals",
            value: "confirmed",
          },
        ],
      },
    ],
  };
  const compiled = compileConditionModel(model);
  assert.isTrue(compiled.valid);
  return {
    actionType: "Condition",
    condition: compiled.valid ? compiled.expression : "",
    conditionModel: serializeConditionModel(model),
  };
}

/**
 * A source holding every kind of node reference a graph stores: members naming
 * their Group through `parentId`, a template token naming an earlier step, and
 * a Condition rule naming an earlier step's output.
 */
const groupedWorkflow: Workflow = {
  ...sourceWorkflow,
  id: "wf_grouped",
  name: "Grouped reminders",
  graph: createSerializedWorkflowGraph({
    nodes: [
      {
        id: "lifecycle-1",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: { label: "Appointment", type: "lifecycle", config: {} },
      },
      {
        id: "group-1",
        type: "group",
        position: { x: 0, y: 200 },
        data: { label: "Reminder", type: "group" },
      },
      {
        id: "lookup-1",
        type: "action",
        parentId: "group-1",
        position: { x: 20, y: 40 },
        data: {
          label: "Look up appointment",
          type: "action",
          config: { actionType: "resend/send-email" },
        },
      },
      {
        id: "wait-1",
        type: "action",
        parentId: "group-1",
        position: { x: 20, y: 200 },
        data: {
          label: "Wait until 24 hours before",
          type: "action",
          config: {
            actionType: "resend/send-email",
            subject: "Status {{@lookup-1:Look up appointment.status}}",
          },
        },
      },
      {
        id: "condition-1",
        type: "action",
        position: { x: 0, y: 600 },
        data: {
          label: "Confirmed?",
          type: "action",
          config: conditionReading("lookup-1"),
        },
      },
    ],
    edges: [
      {
        id: "e1",
        source: "lifecycle-1",
        target: "lookup-1",
        sourceHandle: "started",
      },
      { id: "e2", source: "lookup-1", target: "wait-1" },
      { id: "e3", source: "wait-1", target: "condition-1" },
    ],
  }),
};

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
          actionType: "resend/send-email",
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

    it.effect("gives every copied node a fresh id without run status", () =>
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
          assert.isUndefined(node.attributes.data.status);
        }
      })
    );

    it.effect("moves every node reference onto the copy's own nodes", () =>
      Effect.gen(function* () {
        const repo = makeWorkflowRepo({ source: groupedWorkflow });

        yield* postWorkflowDuplicate(groupedWorkflow.id).pipe(
          Effect.provide(repo.layer)
        );

        const storedGraph = repo.calls.inserts[0]?.graph;
        assert.isDefined(storedGraph);
        const { nodes, edges } = toWorkflowGraphData(storedGraph);
        const idOf = (label: string) => {
          const node = nodes.find(
            (candidate) => candidate.data.label === label
          );
          assert.isDefined(node);
          return node.id;
        };
        const sourceIds = new Set([
          "lifecycle-1",
          "group-1",
          "lookup-1",
          "wait-1",
          "condition-1",
        ]);
        for (const node of nodes) {
          assert.isFalse(sourceIds.has(node.id));
        }

        const groupId = idOf("Reminder");
        const lookupId = idOf("Look up appointment");
        const memberParents = nodes
          .filter((node) => node.parentId !== undefined)
          .map((node) => [node.data.label, node.parentId]);
        assert.deepStrictEqual(memberParents, [
          ["Look up appointment", groupId],
          ["Wait until 24 hours before", groupId],
        ]);

        const waitConfig = nodes.find(
          (node) => node.id === idOf("Wait until 24 hours before")
        )?.data.config;
        assert.strictEqual(
          waitConfig?.subject,
          `Status {{@${lookupId}:Look up appointment.status}}`
        );

        // The rule reads the copied step, and the stored expression is the one
        // compiled from the rewritten model, which is what save holds it to.
        const conditionConfig = nodes.find(
          (node) => node.id === idOf("Confirmed?")
        )?.data.config;
        assert.deepStrictEqual(conditionConfig, conditionReading(lookupId));
        const model = parseConditionModel(conditionConfig?.conditionModel);
        assert.isTrue(model.valid);

        assert.deepStrictEqual(
          edges.map((edge) => [edge.source, edge.target]),
          [
            [idOf("Appointment"), lookupId],
            [lookupId, idOf("Wait until 24 hours before")],
            [idOf("Wait until 24 hours before"), idOf("Confirmed?")],
          ]
        );
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
          'A workflow named "Appointment Reminders (Copy)" already exists. Rename it, then duplicate again.'
        );
        assert.deepStrictEqual(repo.calls.inserts, []);
      })
    );
  });

  // A copy starts paused and unpublished. Subscriptions wait for publish so an
  // unpaused copy cannot double the source's Event starts until someone
  // deliberately publishes it.
  layer(
    Layer.mergeAll(SilentAppLoggerLayer, catalogLayer, stubIntegrationRepo())
  )((it) => {
    it.effect("pauses the copy and leaves subscriptions empty", () =>
      Effect.gen(function* () {
        const repo = makeWorkflowRepo();

        yield* postWorkflowDuplicate(sourceWorkflow.id).pipe(
          Effect.provide(repo.layer)
        );

        const insert = repo.calls.inserts[0];
        assert.isDefined(insert);
        assert.strictEqual(insert.isPaused, true);
        assert.deepStrictEqual(insert.eventSubscriptions, []);
        assert.notStrictEqual(insert.id, sourceWorkflow.id);
      })
    );
  });
});
