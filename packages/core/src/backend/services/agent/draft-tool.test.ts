import { assert, describe, it as test, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { fixtureCatalog } from "@wfgraph/agent/tools/catalog-fixture";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { Workflow } from "#src/backend/lib/db/schema";
import { DraftConflict } from "#src/backend/lib/effect/failures";
import {
  SilentAppLoggerLayer,
  stubExtensionCatalog,
  stubIntegrationRepo,
  stubWfGraphRuntime,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import { executeDraftTool } from "#src/backend/services/agent/draft-tool";
import type { WorkflowRepo } from "#src/backend/services/workflows/repo";

const workflow: Workflow = {
  id: "wf_1",
  name: "Workflow",
  description: null,
  graph: createSerializedWorkflowGraph({
    nodes: [
      {
        id: "entry",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: { type: "lifecycle", label: "Lifecycle", config: {} },
      },
    ],
    edges: [],
  }),
  draftRevision: 1,
  isPaused: false,
  mode: "live",
  visibility: "private",
  publishedVersionId: null,
  createdAt: new Date("2026-09-03T00:00:00.000Z"),
  updatedAt: new Date("2026-09-03T00:00:00.000Z"),
};

const shared = Layer.mergeAll(
  SilentAppLoggerLayer,
  stubExtensionCatalog(fixtureCatalog),
  stubIntegrationRepo({ listIdentities: Effect.succeed([]) })
);

describe("executeDraftTool", () => {
  layer(shared)((it) => {
    it.effect("returns a read result with the persisted draft revision", () =>
      Effect.gen(function* () {
        const result = yield* executeDraftTool({
          workflowId: workflow.id,
          name: "read_workflow",
          arguments: {},
          toolCallId: "call_1",
        }).pipe(
          Effect.provide(
            stubWorkflowRepo({ findById: () => Effect.succeed(workflow) })
          )
        );

        assert.strictEqual(result.workflowId, workflow.id);
        assert.strictEqual(result.draftRevision, 1);
        assert.isFalse(result.isFailure);
        assert.strictEqual(result.result.totalNodes, 1);
      })
    );

    it.effect("lays out and stores one successful graph write", () =>
      Effect.gen(function* () {
        const writes: Array<
          Parameters<WorkflowRepo["Service"]["writeDraft"]>[0]
        > = [];
        const result = yield* executeDraftTool({
          workflowId: workflow.id,
          name: "add_node",
          arguments: { actionId: "score-applicant", label: "Score" },
          toolCallId: "call_2",
          expectedDraftRevision: 1,
        }).pipe(
          Effect.provide(
            stubWorkflowRepo({
              findById: () => Effect.succeed(workflow),
              writeDraft: (input) =>
                Effect.sync(() => {
                  writes.push(input);
                  return {
                    status: "updated" as const,
                    workflow: {
                      ...workflow,
                      graph: input.updates.graph,
                      draftRevision: 2,
                    },
                  };
                }),
            })
          )
        );

        const added = writes[0]?.updates.graph.nodes.find(
          (node) => node.attributes.data.label === "Score"
        );
        assert.isDefined(added);
        assert.strictEqual(result.workflowId, workflow.id);
        assert.strictEqual(result.draftRevision, 2);
        assert.isFalse(result.isFailure);
        assert.strictEqual(result.result.nodeId, added.key);
        assert.notDeepEqual(added.attributes.position, { x: 0, y: 0 });
      })
    );

    it.effect("does not store a canonical tool refusal", () =>
      Effect.gen(function* () {
        const result = yield* executeDraftTool({
          workflowId: workflow.id,
          name: "add_node",
          arguments: { actionId: "missing/action", label: "Missing" },
          toolCallId: "call_3",
          expectedDraftRevision: 1,
        }).pipe(
          Effect.provide(
            stubWorkflowRepo({ findById: () => Effect.succeed(workflow) })
          )
        );

        assert.isTrue(result.isFailure);
        assert.strictEqual(result.draftRevision, 1);
      })
    );

    it.effect("rejects a stale revision before executing the tool", () =>
      Effect.gen(function* () {
        const failure = yield* executeDraftTool({
          workflowId: workflow.id,
          name: "add_node",
          arguments: { actionId: "score-applicant", label: "Score" },
          toolCallId: "call_4",
          expectedDraftRevision: 1,
        }).pipe(
          Effect.provide(
            stubWorkflowRepo({
              findById: () => Effect.succeed({ ...workflow, draftRevision: 2 }),
            })
          ),
          Effect.flip
        );

        assert.instanceOf(failure, DraftConflict);
        assert.strictEqual(failure.currentDraftRevision, 2);
      })
    );

    it.effect("returns a write conflict without retrying the tool", () =>
      Effect.gen(function* () {
        let writeCount = 0;
        const failure = yield* executeDraftTool({
          workflowId: workflow.id,
          name: "add_node",
          arguments: { actionId: "score-applicant", label: "Score" },
          toolCallId: "call_5",
          expectedDraftRevision: 1,
        }).pipe(
          Effect.provide(
            stubWorkflowRepo({
              findById: () => Effect.succeed(workflow),
              writeDraft: () =>
                Effect.sync(() => {
                  writeCount += 1;
                  return {
                    status: "conflict" as const,
                    currentDraftRevision: 2,
                  };
                }),
            })
          ),
          Effect.flip
        );

        assert.instanceOf(failure, DraftConflict);
        assert.strictEqual(failure.currentDraftRevision, 2);
        assert.strictEqual(writeCount, 1);
      })
    );
  });

  test("continues a persisted draft through independently constructed runtimes", async () => {
    let stored = workflow;
    const workflowRepo = {
      findById: (workflowId: string) =>
        Effect.sync(() => (workflowId === stored.id ? stored : null)),
      writeDraft: (
        input: Parameters<WorkflowRepo["Service"]["writeDraft"]>[0]
      ) =>
        Effect.sync(() => {
          if (input.expectedDraftRevision !== stored.draftRevision) {
            return {
              status: "conflict" as const,
              currentDraftRevision: stored.draftRevision,
            };
          }
          stored = {
            ...stored,
            ...input.updates,
            draftRevision: stored.draftRevision + 1,
          };
          return { status: "updated" as const, workflow: stored };
        }),
    };
    const runtimeOptions = {
      extensions: { catalog: fixtureCatalog },
      integrationRepo: { listIdentities: Effect.succeed([]) },
      workflowRepo,
    };
    await using firstRuntime = stubWfGraphRuntime(runtimeOptions);
    await using secondRuntime = stubWfGraphRuntime(runtimeOptions);

    const read = await firstRuntime.runPromise(
      executeDraftTool({
        workflowId: workflow.id,
        name: "read_workflow",
        arguments: {},
        toolCallId: "call_read",
      })
    );
    const write = await secondRuntime.runPromise(
      executeDraftTool({
        workflowId: workflow.id,
        name: "add_node",
        arguments: { actionId: "score-applicant", label: "Score" },
        toolCallId: "call_write",
        expectedDraftRevision: read.draftRevision,
      })
    );

    assert.strictEqual(write.draftRevision, 2);
    assert.strictEqual(stored.draftRevision, 2);
    assert.strictEqual(stored.graph.nodes.length, 2);
  });

  describe("a workflow holding a Group", () => {
    const groupedWorkflow: Workflow = {
      ...workflow,
      graph: createSerializedWorkflowGraph({
        nodes: [
          {
            id: "entry",
            type: "lifecycle",
            position: { x: 0, y: 0 },
            data: { type: "lifecycle", label: "Lifecycle", config: {} },
          },
          {
            id: "lookups",
            type: "group",
            position: { x: 100, y: 200 },
            data: { type: "group", label: "Lookups" },
          },
          ...["a", "b"].map((id) => ({
            id,
            type: "action",
            position: { x: 10, y: 20 },
            parentId: "lookups",
            data: {
              type: "action" as const,
              label: `Score ${id}`,
              config: { actionType: "score-applicant" },
            },
          })),
          {
            id: "outside",
            type: "action",
            position: { x: 0, y: 600 },
            data: {
              type: "action",
              label: "Score outside",
              config: { actionType: "score-applicant" },
            },
          },
          {
            id: "later",
            type: "action",
            position: { x: 0, y: 800 },
            data: {
              type: "action",
              label: "Score later",
              config: { actionType: "score-applicant" },
            },
          },
        ],
        edges: [
          {
            id: "entry-a",
            source: "entry",
            target: "a",
            sourceHandle: "started",
          },
          { id: "a-b", source: "a", target: "b" },
          { id: "b-outside", source: "b", target: "outside" },
          { id: "outside-later", source: "outside", target: "later" },
        ],
      }),
    };

    function persistedDraft() {
      let stored = groupedWorkflow;
      const runtime = stubWfGraphRuntime({
        extensions: { catalog: fixtureCatalog },
        integrationRepo: { listIdentities: Effect.succeed([]) },
        workflowRepo: {
          findById: () => Effect.sync(() => stored),
          writeDraft: (input) =>
            Effect.sync(() => {
              stored = {
                ...stored,
                ...input.updates,
                draftRevision: stored.draftRevision + 1,
              };
              return { status: "updated" as const, workflow: stored };
            }),
        },
      });
      return { runtime, stored: () => stored };
    }

    test("stores a Group rule break and reports it on validation", async () => {
      const { runtime, stored } = persistedDraft();
      await using app = runtime;

      const write = await app.runPromise(
        executeDraftTool({
          workflowId: workflow.id,
          name: "connect_nodes",
          arguments: { source: "a", target: "later" },
          toolCallId: "call_connect",
          expectedDraftRevision: 1,
        })
      );
      const validation = await app.runPromise(
        executeDraftTool({
          workflowId: workflow.id,
          name: "validate_workflow",
          arguments: {},
          toolCallId: "call_validate",
        })
      );

      assert.isFalse(write.isFailure);
      assert.strictEqual(stored().draftRevision, 2);
      assert.strictEqual(stored().graph.edges.length, 5);
      assert.isTrue(validation.result.draftValid);
      assert.deepInclude(
        Array.isArray(validation.result.publishBlockers)
          ? validation.result.publishBlockers
          : [],
        {
          kind: "invalid_group",
          nodeId: "lookups",
          nodeLabel: "Lookups",
          message:
            'Group "Lookups" continues from 2 outlets inside it to 2 steps outside it. Connect every outlet that leaves a Group to the same step, or leave the Group from one outlet',
        }
      );
    });

    test("stores the dissolved Group when a delete leaves one step", async () => {
      const { runtime, stored } = persistedDraft();
      await using app = runtime;

      const write = await app.runPromise(
        executeDraftTool({
          workflowId: workflow.id,
          name: "delete_node",
          arguments: { nodeId: "b" },
          toolCallId: "call_delete",
          expectedDraftRevision: 1,
        })
      );

      const nodes = stored().graph.nodes;
      assert.isFalse(write.isFailure);
      assert.strictEqual(write.draftRevision, 2);
      assert.deepEqual(
        nodes.map((node) => node.key),
        ["entry", "a", "outside", "later"]
      );
      assert.isUndefined(
        nodes.find((node) => node.key === "a")?.attributes.parentId
      );
    });
  });
});
