import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { Chat, LanguageModel, Response } from "effect/unstable/ai";
import type {
  AgentDocument,
  WorkflowDraftService,
} from "@wfgraph/agent/document";
import { layerFromDraft } from "@wfgraph/agent/document";
import { agentToolkit, agentToolkitLayer } from "@wfgraph/agent/toolkit";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { agenticSteps, withGraphParts } from "#src/backend/agent/chat";
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
  catalog: { actions: [], events: [], integrations: [] },
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
            draft,
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
          draft,
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
              draft,
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
          withGraphParts(providerParts, draft, () => undefined),
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
              return next;
            }),
          revision: (revision) => Effect.succeed(revisions[revision]!),
          catalog: { actions: [], events: [], integrations: [] },
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
            delayedDraft,
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
});
