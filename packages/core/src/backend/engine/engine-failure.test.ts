import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import {
  engineFailure,
  failureFromCause,
} from "#src/backend/engine/engine-failure";

describe("engine failure classification", () => {
  it.effect("preserves a typed engine failure", () =>
    Effect.sync(() => {
      const failure = engineFailure("failure", "The vendor refused the call");

      assert.deepStrictEqual(failureFromCause(Cause.fail(failure)), failure);
    })
  );

  it.effect("classifies an unchecked error as a defect", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        failureFromCause(Cause.die(new Error("broken invariant"))),
        {
          kind: "defect",
          message: "broken invariant",
        }
      );
    })
  );

  it.effect("uses a stable message for interruption", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(failureFromCause(Cause.interrupt()), {
        kind: "interrupt",
        message: "Workflow execution was interrupted",
      });
    })
  );
});
