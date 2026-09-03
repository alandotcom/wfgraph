import { describe, expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import {
  AGENT_TURN_STEP_LIMIT,
  runAgentStepLoop,
} from "#src/backend/agent/step-loop";

describe("runAgentStepLoop", () => {
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
        })
      );

      expect(parts).toHaveLength(25);
      expect(parts.at(-1)).toEqual({ type: "text" });
    })
  );
});
