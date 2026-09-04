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
});
