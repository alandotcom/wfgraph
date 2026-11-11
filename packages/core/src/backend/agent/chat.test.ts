import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { Chat, LanguageModel, Response } from "effect/ai";
import type {
  AgentDocument,
  WorkflowDraftService,
} from "@wfgraph/agent/document";
import { layerFromDraft } from "@wfgraph/agent/document";
import { agentToolkit, agentToolkitLayer } from "@wfgraph/agent/toolkit";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { AgentStreamPart } from "@wfgraph/shared/rpc/agent-stream";
import {
  agentPrompt,
  agenticSteps,
  hostAgentRunner,
  streamAgentTurn,
  withGraphParts,
} from "#src/backend/agent/chat";
import {
  runAgentRunner,
  type WfGraphAgentTurn,
} from "#src/backend/agent/runner";
import { makeAgentToolSession } from "#src/backend/agent/tool-session";
import {
  finishReasonFailure,
  type AgentTraceEvent,
} from "#src/backend/agent/trace";
import { observeAgentStream } from "#src/backend/services/agent/chat";

const document: AgentDocument = {
  nodes: [
    {
      id: "entry",
      type: "lifecycle",
      position: { x: 0, y: 0 },
      data: { label: "Lifecycle", type: "lifecycle", config: {} },
    },
  ],
  edges: [],
};

const draft: WorkflowDraftService = {
  current: Effect.succeed({
    nodes: [
      ...document.nodes,
      {
        id: "later-write",
        type: "action",
        position: { x: 0, y: 0 },
        data: { label: "Later", type: "action", config: {} },
      },
    ],
    edges: [],
  }),
  update: () => Effect.die("unused"),
  revision: () => Effect.succeed(document),
  latest: Effect.succeed({ revision: 1, document }),
  catalog: { actions: [], entities: [], events: [], integrations: [] },
  integrations: [],
  validateDraft: () => ({
    draftValid: true,
    structuralIssues: [],
    publishBlockers: [],
    warnings: [],
  }),
};

const part = Response.makePart;

describe("withGraphParts", () => {
  it.effect(
    "captures raw write results and the graph revision they produced",
    () =>
      Effect.gen(function* () {
        const trace: AgentTraceEvent[] = [];
        const result = { nodeId: "entry", summary: "Updated Lifecycle." };
        const parts = yield* Stream.runCollect(
          withGraphParts(
            Stream.succeed({
              step: 2,
              part: part("tool-result", {
                id: "call-1",
                name: "update_node",
                result,
                encodedResult: result,
                isFailure: false,
                providerExecuted: false,
                preliminary: false,
              }),
            }),
            { draft },
            (event) => trace.push(event)
          )
        );

        expect(parts).toEqual([
          {
            type: "tool-result",
            id: "call-1",
            name: "update_node",
            summary: "Updated Lifecycle.",
            failed: false,
          },
          {
            type: "graph",
            graph: createSerializedWorkflowGraph({
              nodes: [...document.nodes],
              edges: [...document.edges],
            }),
          },
        ]);
        expect(trace).toEqual([
          {
            type: "tool-result",
            step: 2,
            id: "call-1",
            name: "update_node",
            result,
            failed: false,
            graphRevision: 1,
          },
          {
            type: "graph-revision",
            step: 2,
            toolCallId: "call-1",
            revision: 1,
            document,
          },
        ]);
      })
  );

  it.effect("records a token-limit finish before failing the stream", () =>
    Effect.gen(function* () {
      const trace: AgentTraceEvent[] = [];
      yield* Stream.runDrain(
        withGraphParts(
          Stream.succeed({
            step: 1,
            part: part("finish", {
              reason: "length",
              usage: new Response.Usage({
                inputTokens: { total: 10 },
                outputTokens: { total: 5 },
              }),
            }),
          }),
          { draft },
          (event) => trace.push(event)
        )
      );
      expect(trace).toEqual([
        {
          type: "model-step-finish",
          step: 1,
          reason: "length",
          usage: {
            inputTokens: { total: 10 },
            outputTokens: { total: 5 },
          },
        },
      ]);
    })
  );

  it.effect(
    "turns a standalone provider error into one browser error and trace event",
    () =>
      Effect.gen(function* () {
        const trace: AgentTraceEvent[] = [];
        const toolkit = yield* Effect.provide(
          agentToolkit,
          agentToolkitLayer.pipe(Layer.provide(layerFromDraft(draft)))
        );
        const session = yield* Chat.fromPrompt([]);
        const modelLayer = Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateText: () => Effect.succeed([]),
            streamText: () =>
              Stream.succeed(
                part("error", { error: new Error("provider failed") })
              ),
          })
        );

        const parts = yield* Stream.runCollect(
          observeAgentStream(
            withGraphParts(
              agenticSteps({
                session,
                toolkit,
                observeTrace: (event) => trace.push(event),
              }).pipe(Stream.provide(modelLayer)),
              { draft },
              (event) => trace.push(event)
            ),
            () => Effect.void
          )
        );

        expect(parts).toEqual([
          {
            type: "error",
            message: "The model provider stopped with an error.",
          },
        ]);
        expect(trace).toEqual([
          {
            type: "model-step-start",
            step: 1,
          },
          {
            type: "provider-error",
            step: 1,
            error: "provider failed",
          },
        ]);
      })
  );

  it.effect("turns a provider error and finish into one browser error", () =>
    Effect.gen(function* () {
      const failure =
        finishReasonFailure("error") ??
        new Error("The error finish reason must fail.");

      const providerParts = Stream.fromIterable([
        {
          step: 1,
          part: part("error", { error: new Error("provider failed") }),
        },
        {
          step: 1,
          part: part("finish", {
            reason: "error",
            usage: new Response.Usage({
              inputTokens: { total: 10 },
              outputTokens: { total: 0 },
            }),
          }),
        },
      ]).pipe(Stream.concat(Stream.fail(failure)));

      const parts = yield* Stream.runCollect(
        observeAgentStream(
          withGraphParts(providerParts, { draft }, () => undefined),
          () => Effect.void
        )
      );

      expect(parts).toEqual([
        {
          type: "error",
          message: "The model provider stopped with an error.",
        },
      ]);
    })
  );

  it.effect(
    "runs delayed write handlers one at a time and links each result to its revision",
    () =>
      Effect.gen(function* () {
        let current = document;
        const revisions = [document];
        let activeHandlers = 0;
        let maximumActiveHandlers = 0;
        let modelCalls = 0;
        const trace: AgentTraceEvent[] = [];

        const delayedDraft: WorkflowDraftService = {
          current: Effect.sync(() => current),
          update: (edit) =>
            Effect.gen(function* () {
              activeHandlers += 1;
              maximumActiveHandlers = Math.max(
                maximumActiveHandlers,
                activeHandlers
              );
              yield* Effect.promise(
                () => new Promise<void>((resolve) => setTimeout(resolve, 10))
              );
              const next = edit(current);
              current = next;
              revisions.push(next);
              activeHandlers -= 1;
              return { document: next, dissolvedGroups: [] };
            }),
          revision: (revision) => Effect.succeed(revisions[revision]!),
          latest: Effect.sync(() => ({
            revision: revisions.length - 1,
            document: current,
          })),
          catalog: { actions: [], entities: [], events: [], integrations: [] },
          integrations: [],
          validateDraft: () => ({
            draftValid: true,
            structuralIssues: [],
            publishBlockers: [],
            warnings: [],
          }),
        };

        const toolkit = yield* Effect.provide(
          agentToolkit,
          agentToolkitLayer.pipe(Layer.provide(layerFromDraft(delayedDraft)))
        );
        const session = yield* Chat.fromPrompt([]);
        const modelLayer = Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateText: () => Effect.succeed([]),
            streamText: () => {
              const parts =
                modelCalls++ === 0
                  ? [
                      part("tool-call", {
                        id: "call-1",
                        name: "update_node",
                        params: { nodeId: "entry", label: "First" },
                        providerExecuted: false,
                      }),
                      part("tool-call", {
                        id: "call-2",
                        name: "update_node",
                        params: { nodeId: "entry", label: "Second" },
                        providerExecuted: false,
                      }),
                      part("finish", {
                        reason: "tool-calls",
                        usage: new Response.Usage({
                          inputTokens: { total: 10 },
                          outputTokens: { total: 5 },
                        }),
                      }),
                    ]
                  : [
                      part("finish", {
                        reason: "stop",
                        usage: new Response.Usage({
                          inputTokens: { total: 10 },
                          outputTokens: { total: 2 },
                        }),
                      }),
                    ];
              return Stream.fromIterable(parts);
            },
          })
        );

        const responseParts = yield* Stream.runCollect(
          withGraphParts(
            agenticSteps({
              session,
              toolkit,
              observeTrace: (event) => trace.push(event),
            }).pipe(Stream.provide(modelLayer)),
            { draft: delayedDraft },
            (event) => trace.push(event)
          )
        );

        const successfulResults = trace.filter(
          (event): event is Extract<AgentTraceEvent, { type: "tool-result" }> =>
            event.type === "tool-result" && !event.failed
        );
        const graphRevisions = trace.filter(
          (
            event
          ): event is Extract<AgentTraceEvent, { type: "graph-revision" }> =>
            event.type === "graph-revision"
        );

        expect(maximumActiveHandlers).toBe(1);
        expect(
          responseParts.filter((response) => response.type === "graph")
        ).toHaveLength(2);
        expect(successfulResults.map((result) => result.graphRevision)).toEqual(
          [1, 2]
        );
        expect(graphRevisions.map((revision) => revision.document)).toEqual([
          revisions[1],
          revisions[2],
        ]);
        expect(graphRevisions.map((revision) => revision.toolCallId)).toEqual([
          "call-1",
          "call-2",
        ]);
        for (const result of successfulResults) {
          expect(result.graphRevision).toBeDefined();
          const revision = graphRevisions.find(
            (candidate) =>
              candidate.toolCallId === result.id &&
              candidate.revision === result.graphRevision
          );
          expect(revision).toBeDefined();
          expect(revision?.document).toBe(revisions[result.graphRevision!]);
        }
      })
  );

  it.effect(
    "draws no revision for a refused write and the draft's own revision for an accepted one",
    () =>
      Effect.gen(function* () {
        const trace: AgentTraceEvent[] = [];
        const toolSession = yield* makeAgentToolSession({
          document,
          catalog: { actions: [], entities: [], events: [], integrations: [] },
          integrations: [],
          validateDraft: () => ({
            draftValid: true,
            structuralIssues: [],
            publishBlockers: [],
            warnings: [],
          }),
        });
        let modelCalls = 0;
        const modelLayer = Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateText: () => Effect.succeed([]),
            streamText: () =>
              Stream.fromIterable(
                modelCalls++ === 0
                  ? [
                      part("tool-call", {
                        id: "refused",
                        name: "update_node",
                        params: { nodeId: "missing", label: "Nowhere" },
                        providerExecuted: false,
                      }),
                      part("tool-call", {
                        id: "accepted",
                        name: "update_node",
                        params: { nodeId: "entry", label: "Renamed" },
                        providerExecuted: false,
                      }),
                      part("finish", {
                        reason: "tool-calls",
                        usage: new Response.Usage({
                          inputTokens: { total: 10 },
                          outputTokens: { total: 5 },
                        }),
                      }),
                    ]
                  : [
                      part("finish", {
                        reason: "stop",
                        usage: new Response.Usage({
                          inputTokens: { total: 10 },
                          outputTokens: { total: 2 },
                        }),
                      }),
                    ]
              ),
          })
        );

        const responseParts = yield* Stream.runCollect(
          withGraphParts(
            agenticSteps({
              session: yield* Chat.fromPrompt([]),
              toolkit: toolSession.toolkit,
              observeTrace: (event) => trace.push(event),
            }).pipe(Stream.provide(modelLayer)),
            toolSession,
            (event) => trace.push(event)
          )
        );
        const renamed = yield* toolSession.draft.current;

        expect(renamed.nodes[0]?.data.label).toBe("Renamed");
        expect(
          trace.flatMap((event) =>
            event.type === "tool-result"
              ? [{ id: event.id, graphRevision: event.graphRevision }]
              : []
          )
        ).toEqual([
          { id: "refused", graphRevision: undefined },
          { id: "accepted", graphRevision: 1 },
        ]);
        expect(
          trace.filter((event) => event.type === "graph-revision")
        ).toEqual([
          {
            type: "graph-revision",
            step: 1,
            toolCallId: "accepted",
            revision: 1,
            document: renamed,
          },
        ]);
        expect(
          responseParts.filter((response) => response.type === "graph")
        ).toEqual([
          {
            type: "graph",
            graph: createSerializedWorkflowGraph({
              nodes: [...renamed.nodes],
              edges: [...renamed.edges],
            }),
          },
        ]);
      })
  );
});

describe("hostAgentRunner", () => {
  it.effect(
    "draws the draft after a host's successful write and drops its own graph parts",
    () =>
      Effect.gen(function* () {
        const session = yield* makeAgentToolSession({
          document,
          catalog: { actions: [], entities: [], events: [], integrations: [] },
          integrations: [],
          validateDraft: () => ({
            draftValid: true,
            structuralIssues: [],
            publishBlockers: [],
            warnings: [],
          }),
        });
        const trace: AgentTraceEvent[] = [];
        let received: WfGraphAgentTurn | undefined;
        const runner = hostAgentRunner({
          provider: "host",
          model: "host-model",
          run: (turn) => {
            received = turn;
            return Stream.fromIterable<AgentStreamPart>([
              {
                type: "graph",
                graph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
              },
              { type: "tool-call", id: "c1", name: "add_node", input: {} },
              {
                type: "tool-result",
                id: "c1",
                name: "add_node",
                summary: "Added a step.",
                failed: false,
              },
              {
                type: "tool-result",
                id: "c2",
                name: "read_workflow",
                failed: false,
              },
            ]);
          },
        });

        const parts = yield* Stream.runCollect(
          runAgentRunner(runner, {
            workflowId: "workflow-1",
            messages: [{ role: "user", content: "Add a step" }],
            session,
            observeTrace: (event) => trace.push(event),
          })
        );

        expect(Array.from(parts).map((streamed) => streamed.type)).toEqual([
          "tool-call",
          "tool-result",
          "graph",
          "tool-result",
        ]);
        expect(received?.workflowId).toBe("workflow-1");
        expect(received?.toolkit).toBe(session.toolkit);
        expect(received?.prompt.content.at(-1)).toMatchObject({
          role: "user",
        });
        expect(trace.map((event) => event.type)).toEqual([
          "tool-call",
          "tool-result",
          "graph-revision",
          "tool-result",
        ]);
      })
  );
});

describe("streamAgentTurn", () => {
  it.effect("runs the built-in loop on a model the host supplies", () =>
    Effect.gen(function* () {
      const session = yield* makeAgentToolSession({
        document,
        catalog: { actions: [], entities: [], events: [], integrations: [] },
        integrations: [],
        validateDraft: () => ({
          draftValid: true,
          structuralIssues: [],
          publishBlockers: [],
          warnings: [],
        }),
      });
      const model = Layer.effect(
        LanguageModel.LanguageModel,
        LanguageModel.make({
          generateText: () => Effect.succeed([]),
          streamText: () =>
            Stream.fromIterable([
              part("text-delta", { id: "t1", delta: "Done" }),
              part("finish", {
                reason: "stop",
                usage: new Response.Usage({
                  inputTokens: { total: 3 },
                  outputTokens: { total: 1 },
                }),
              }),
            ]),
        })
      );

      const parts = yield* Stream.runCollect(
        streamAgentTurn(
          {
            workflowId: "workflow-1",
            messages: [{ role: "user", content: "Hello" }],
            prompt: agentPrompt({
              messages: [{ role: "user", content: "Hello" }],
            }),
            toolkit: session.toolkit,
            signal: yield* Effect.abortSignal,
          },
          model
        )
      );

      expect(Array.from(parts)).toEqual([
        { type: "text-delta", id: "t1", delta: "Done" },
      ]);
    })
  );
});
