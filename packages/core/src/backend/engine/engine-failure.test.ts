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

  it.effect(
    "keeps a defect when the same cause also carries interruption",
    () =>
      Effect.sync(() => {
        const cause = Cause.fromReasons([
          Cause.makeDieReason(new Error("broken during interruption")),
          Cause.makeInterruptReason(),
        ]);

        assert.deepStrictEqual(failureFromCause(cause), {
          kind: "defect",
          message: "broken during interruption",
        });
      })
  );

  it.effect("keeps a typed failure alongside interruption", () =>
    Effect.sync(() => {
      const failure = engineFailure("failure", "The vendor refused the call");
      const cause = Cause.fromReasons([
        Cause.makeFailReason(failure),
        Cause.makeInterruptReason(),
      ]);

      assert.deepStrictEqual(failureFromCause(cause), failure);
    })
  );

  it.effect("takes a defect's message over a typed failure", () =>
    Effect.sync(() => {
      const cause = Cause.fromReasons([
        Cause.makeFailReason(engineFailure("failure", "ordinary refusal")),
        Cause.makeDieReason(new Error("broken invariant")),
      ]);

      assert.deepStrictEqual(failureFromCause(cause), {
        kind: "defect",
        message: "broken invariant",
      });
    })
  );
});
