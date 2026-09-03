import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  References,
  Semaphore,
  Stream,
} from "effect";
import { describe, expect, it } from "@effect/vitest";
import type { AgentStreamPart } from "@wfgraph/shared/rpc/agent-stream";
import { makeAgentTraceAccumulator } from "#src/backend/agent/trace";
import { makeRecordingLogger } from "#src/backend/lib/effect/test-layers";
import {
  agentTurnLogLevel,
  agentTurnStatus,
  limitAgentStream,
  observeAgentStream,
  observeAgentTurn,
} from "#src/backend/services/agent/chat";

const reply: AgentStreamPart = {
  type: "text-delta",
  id: "text-1",
  delta: "Ready",
};

describe("observeAgentStream", () => {
  it.effect("records a running failure before returning it to the client", () =>
    Effect.gen(function* () {
      const failures: unknown[] = [];
      const parts = yield* Stream.runCollect(
        observeAgentStream(Stream.fail(new Error("provider failed")), (cause) =>
          Effect.sync(() => failures.push(cause))
        )
      );

      expect(failures).toHaveLength(1);
      expect(parts).toEqual([{ type: "error", message: "provider failed" }]);
    })
  );

  it.effect("lets request cancellation end the stream quietly", () =>
    Effect.gen(function* () {
      const failures: unknown[] = [];
      const parts = yield* Stream.runCollect(
        observeAgentStream(Stream.failCause(Cause.interrupt()), (cause) =>
          Effect.sync(() => failures.push(cause))
        )
      );

      expect(failures).toEqual([]);
      expect(parts).toEqual([]);
    })
  );
});

describe("agentTurnStatus", () => {
  it("classifies normal, incomplete, failed, and cancelled exits", () => {
    expect(agentTurnStatus(Exit.succeed(undefined), "stop")).toBe("completed");
    expect(agentTurnStatus(Exit.fail("limit"), "length")).toBe("incomplete");
    expect(agentTurnStatus(Exit.fail("provider"), undefined)).toBe("failed");
    expect(agentTurnStatus(Exit.failCause(Cause.interrupt()), undefined)).toBe(
      "cancelled"
    );
  });

  it("uses warning severity for unsuccessful provider finishes", () => {
    expect(agentTurnLogLevel("completed")).toBe("info");
    expect(agentTurnLogLevel("cancelled")).toBe("info");
    expect(agentTurnLogLevel("incomplete")).toBe("warn");
    expect(agentTurnLogLevel("failed")).toBe("warn");
  });
});

describe("observeAgentTurn", () => {
  it.effect(
    "writes one payload-free aggregate record for a completed turn",
    () =>
      Effect.gen(function* () {
        const trace = makeAgentTraceAccumulator();
        trace.observe({ type: "model-step-start", step: 1 });
        trace.observe({
          type: "tool-call",
          step: 1,
          id: "call-1",
          name: "read_workflow",
          input: { secretInput: "must-not-be-logged" },
        });
        trace.observe({
          type: "tool-result",
          step: 1,
          id: "call-1",
          name: "read_workflow",
          result: { secretResult: "must-not-be-logged" },
          failed: false,
        });
        trace.observe({
          type: "graph-revision",
          step: 1,
          toolCallId: "call-2",
          revision: 1,
          document: {
            nodes: [
              {
                id: "secret-node",
                type: "action",
                position: { x: 0, y: 0 },
                data: { label: "Secret node", type: "action", config: {} },
              },
            ],
            edges: [],
          },
        });
        trace.observe({
          type: "model-step-finish",
          step: 1,
          reason: "stop",
          usage: {
            inputTokens: { total: 100 },
            outputTokens: { total: 20, reasoning: 5 },
          },
        });
        const recording = makeRecordingLogger();

        const parts = yield* Stream.runCollect(
          observeAgentTurn({
            parts: Stream.succeed(reply),
            trace,
            logger: recording.logger,
            workflowId: "workflow-1",
            messageCount: 2,
            model: "model-1",
            startedAt: 100,
            now: () => 150,
          })
        );

        expect(parts).toEqual([reply]);
        expect(recording.infoLines).toEqual([
          {
            message: "Agent turn finished",
            properties: {
              run: {
                workflowId: "workflow-1",
                status: "completed",
                messages: 2,
                ms: 50,
              },
              model: {
                id: "model-1",
                calls: 1,
                finishReason: "stop",
                finishReasons: ["stop"],
              },
              tools: { calls: 1, refusals: 0, graphRevisions: 1 },
              usage: {
                inputTokens: 100,
                outputTokens: 20,
                reasoningTokens: 5,
                totalTokens: 120,
              },
            },
          },
        ]);
        expect(recording.warnLines).toEqual([]);
        expect(JSON.stringify(recording.infoLines)).not.toContain("secret");
      })
  );

  it.effect("logs provider and thrown failures once at warning severity", () =>
    Effect.gen(function* () {
      const cases = [
        { reason: "error" as const, status: "incomplete" },
        { reason: undefined, status: "failed" },
      ];

      for (const testCase of cases) {
        const trace = makeAgentTraceAccumulator();
        if (testCase.reason) {
          trace.observe({
            type: "model-step-finish",
            step: 1,
            reason: testCase.reason,
            usage: { inputTokens: {}, outputTokens: {} },
          });
        }
        const recording = makeRecordingLogger();

        const parts = yield* Stream.runCollect(
          observeAgentTurn({
            parts: Stream.fail(new Error("provider failed")),
            trace,
            logger: recording.logger,
            workflowId: "workflow-1",
            messageCount: 1,
            model: "model-1",
            startedAt: 100,
            now: () => 150,
          })
        );

        expect(parts).toEqual([{ type: "error", message: "provider failed" }]);
        expect(recording.infoLines).toEqual([]);
        expect(recording.warnLines).toHaveLength(1);
        expect(recording.warnLines[0]?.properties).toMatchObject({
          run: { status: testCase.status },
          error: { message: "provider failed" },
        });
      }
    })
  );

  it.effect("logs an interrupted turn once and sends no browser error", () =>
    Effect.gen(function* () {
      const recording = makeRecordingLogger();

      const parts = yield* Stream.runCollect(
        observeAgentTurn({
          parts: Stream.failCause(Cause.interrupt()),
          trace: makeAgentTraceAccumulator(),
          logger: recording.logger,
          workflowId: "workflow-1",
          messageCount: 1,
          model: "model-1",
          startedAt: 100,
          now: () => 150,
        })
      );

      expect(parts).toEqual([]);
      expect(recording.infoLines).toHaveLength(1);
      expect(recording.infoLines[0]?.properties).toMatchObject({
        run: { status: "cancelled" },
      });
      expect(recording.warnLines).toEqual([]);
    })
  );
});

describe("limitAgentStream", () => {
  it.effect("refuses a turn when every agent permit is occupied", () =>
    Effect.gen(function* () {
      const capacity = yield* Semaphore.make(1);
      yield* capacity.take(1);

      const parts = yield* Stream.runCollect(
        limitAgentStream(Stream.succeed(reply), capacity)
      );

      expect(parts).toEqual([
        {
          type: "error",
          message:
            "The build agent is busy with other turns. Wait for one to finish and try again.",
        },
      ]);
      yield* capacity.release(1);
    })
  );

  it.effect("returns its permit when the stream finishes", () =>
    Effect.gen(function* () {
      const capacity = yield* Semaphore.make(1);
      const parts = yield* Stream.runCollect(
        limitAgentStream(Stream.succeed(reply), capacity)
      );

      expect(parts).toEqual([reply]);
      expect(yield* capacity.takeIfAvailable(1)).toBe(true);
      yield* capacity.release(1);
    })
  );

  it.effect("returns its permit when the stream is interrupted", () =>
    Effect.gen(function* () {
      const capacity = yield* Semaphore.make(1);

      yield* Stream.runDrain(
        limitAgentStream(Stream.failCause(Cause.interrupt()), capacity)
      ).pipe(Effect.exit);

      expect(yield* capacity.takeIfAvailable(1)).toBe(true);
      yield* capacity.release(1);
    })
  );

  it.effect(
    "returns its permit when the consumer is interrupted during acquisition",
    () =>
      Effect.gen(function* () {
        const capacity = yield* Semaphore.make(1);
        const acquired = yield* Deferred.make<void>();
        const continueAcquisition = yield* Deferred.make<void>();
        const takeIfAvailable = capacity.takeIfAvailable.bind(capacity);
        capacity.takeIfAvailable = (permits) =>
          Effect.gen(function* () {
            const result = yield* takeIfAvailable(permits);
            yield* Deferred.succeed(acquired, undefined);
            yield* Deferred.await(continueAcquisition);
            return result;
          });
        const fiber = yield* Effect.forkChild(
          Stream.runDrain(limitAgentStream(Stream.never, capacity))
        );

        yield* Deferred.await(acquired);
        const interruption = yield* Effect.forkChild(Fiber.interrupt(fiber));
        yield* Deferred.succeed(continueAcquisition, undefined);
        yield* Fiber.join(interruption);

        expect(yield* capacity.takeIfAvailable(1)).toBe(true);
        yield* capacity.release(1);
      }).pipe(Effect.provideService(References.MaxOpsBeforeYield, 3))
  );
});
