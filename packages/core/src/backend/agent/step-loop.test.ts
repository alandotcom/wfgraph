import { describe, expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import {
  AGENT_TURN_STEP_LIMIT,
  runAgentStepLoop,
} from "#src/backend/agent/step-loop";
import { finishReasonFailure } from "#src/backend/agent/trace";

describe("runAgentStepLoop", () => {
  it.effect("fails a model step that ends without a finish part", () =>
    Effect.gen(function* () {
      const exit = yield* Stream.runDrain(
        runAgentStepLoop({
          limit: 1,
          step: () => Stream.succeed({ type: "text" as const }),
          calledTool: () => false,
          stepCompletion: () => undefined,
        })
      ).pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain(
          "Model step 1 ended without a finish part."
        );
      }
    })
  );

  it.effect("fails an error-only model step with one safe provider error", () =>
    Effect.gen(function* () {
      const exit = yield* Stream.runDrain(
        runAgentStepLoop({
          limit: 1,
          step: () => Stream.succeed({ type: "error" as const }),
          calledTool: () => false,
          stepCompletion: () => undefined,
          stepFailure: (part) =>
            part.type === "error" ? finishReasonFailure("error") : undefined,
        })
      ).pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain(
          "The model provider stopped with an error."
        );
      }
    })
  );

  it.effect("fails a tool-call finish that emitted no tool call", () =>
    Effect.gen(function* () {
      const exit = yield* Stream.runDrain(
        runAgentStepLoop({
          limit: 1,
          step: () => Stream.succeed({ type: "finish" as const }),
          calledTool: () => false,
          stepCompletion: () => ({ calledTool: true }),
        })
      ).pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain(
          "Model step 1 reported tool calls but emitted none."
        );
      }
    })
  );

  it.effect("fails an incomplete provider finish after emitting it", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const exit = yield* Stream.runForEach(
        runAgentStepLoop({
          limit: 1,
          step: () => Stream.succeed({ type: "finish" as const }),
          calledTool: () => false,
          stepCompletion: () => ({
            calledTool: false,
            failure: finishReasonFailure("length"),
          }),
        }),
        (part) => Effect.sync(() => seen.push(part.type))
      ).pipe(Effect.exit);

      expect(seen).toEqual(["finish"]);
      expect(exit._tag).toBe("Failure");
    })
  );

  it.effect("marks the start of every model step", () =>
    Effect.gen(function* () {
      let calls = 0;
      const started: number[] = [];

      yield* Stream.runDrain(
        runAgentStepLoop({
          limit: 3,
          step: () => {
            calls += 1;
            return Stream.succeed({ calledTool: calls === 1 });
          },
          calledTool: (part) => part.calledTool,
          stepCompletion: (part) => ({ calledTool: part.calledTool }),
          onStepStart: (step) => started.push(step),
        })
      );

      expect(started).toEqual([1, 2]);
    })
  );

  it.effect("allows a turn to finish after more than 24 model steps", () =>
    Effect.gen(function* () {
      let calls = 0;
      const parts = yield* Stream.runCollect(
        runAgentStepLoop({
          limit: AGENT_TURN_STEP_LIMIT,
          step: () => {
            calls += 1;
            return Stream.succeed({
              type: calls < 25 ? ("tool-call" as const) : ("text" as const),
            });
          },
          calledTool: (part) => part.type === "tool-call",
          stepCompletion: (part) => ({
            calledTool: part.type === "tool-call",
          }),
        })
      );

      expect(parts).toHaveLength(25);
      expect(parts.at(-1)).toEqual({ type: "text" });
    })
  );
});
