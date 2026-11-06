import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { InternalFailure, NotFound } from "#src/backend/lib/effect/failures";
import {
  catchSeamFailures,
  internalFailure,
  internalFailureFromCause,
} from "#src/backend/lib/effect/internal-failure";
import { DriverError } from "#src/backend/services/executions/driver";
import { makeRecordingLogger } from "#src/backend/lib/effect/test-layers";

describe("internalFailure", () => {
  it.effect(
    "logs the underlying error and answers with the caller's message",
    () =>
      Effect.gen(function* () {
        const recorder = makeRecordingLogger();
        const cause = new Error("connection refused");

        const failure = yield* Effect.fail(new DatabaseError({ cause })).pipe(
          Effect.catchTag(
            "DatabaseError",
            internalFailure(recorder.logger, "Failed to list API keys")
          ),
          Effect.flip
        );

        assert.instanceOf(failure, InternalFailure);
        assert.strictEqual(failure.error, "Failed to list API keys");
        assert.deepStrictEqual(recorder.lines, [
          {
            message: "Failed to list API keys: connection refused",
            properties: { error: cause },
          },
        ]);
      })
  );
});

describe("internalFailureFromCause", () => {
  it.effect(
    "keeps the underlying message in the log and out of the caller response",
    () =>
      Effect.gen(function* () {
        const recorder = makeRecordingLogger();
        const cause = new Error(
          "duplicate key value violates unique constraint"
        );

        const failure = yield* Effect.fail(new DatabaseError({ cause })).pipe(
          Effect.catchTag(
            "DatabaseError",
            internalFailureFromCause(
              Effect.succeed(recorder.logger),
              "Failed to save current workflow"
            )
          ),
          Effect.flip,
          Effect.provide(recorder.layer)
        );

        assert.instanceOf(failure, InternalFailure);
        assert.strictEqual(failure.error, "Failed to save current workflow");
        assert.deepStrictEqual(recorder.lines, [
          {
            message:
              "Failed to save current workflow: duplicate key value violates unique constraint",
            properties: { error: cause },
          },
        ]);
      })
  );

  // The entrypoints whose two sentences differ: the operator greps for the log
  // line, while the caller is told what they asked for failed.
  it.effect("uses the caller's own message", () =>
    Effect.gen(function* () {
      const recorder = makeRecordingLogger();

      const failure = yield* Effect.fail(
        new DatabaseError({ cause: "connection lost" })
      ).pipe(
        Effect.catchTag(
          "DatabaseError",
          internalFailureFromCause(
            Effect.succeed(recorder.logger),
            "Failed to start workflow execution",
            "Failed to execute workflow"
          )
        ),
        Effect.flip,
        Effect.provide(recorder.layer)
      );

      assert.strictEqual(failure.error, "Failed to execute workflow");
      assert.strictEqual(
        recorder.lines[0]?.message,
        "Failed to start workflow execution: connection lost"
      );
    })
  );

  // One policy covers both seams, which is why it reads `cause` rather than
  // naming the class it came from.
  it.effect("answers a refused executor write the same way", () =>
    Effect.gen(function* () {
      const recorder = makeRecordingLogger();
      const cause = new Error("schedule row refused");

      const failure = yield* Effect.fail(new DriverError({ cause })).pipe(
        Effect.catchTag(
          "DriverError",
          internalFailureFromCause(
            Effect.succeed(recorder.logger),
            "Failed to cancel execution"
          )
        ),
        Effect.flip,
        Effect.provide(recorder.layer)
      );

      assert.strictEqual(failure.error, "Failed to cancel execution");
      assert.strictEqual(
        recorder.lines[0]?.message,
        "Failed to cancel execution: schedule row refused"
      );
    })
  );
});

describe("catchSeamFailures", () => {
  it.effect(
    "answers the executor's refusal like the other seams and leaves domain failures alone",
    () =>
      Effect.gen(function* () {
        const recorder = makeRecordingLogger();
        const answer = <E>(error: E) =>
          Effect.fail(error).pipe(
            catchSeamFailures(
              Effect.succeed(recorder.logger),
              "Failed to start workflow execution",
              "Failed to execute workflow"
            ),
            Effect.flip,
            Effect.provide(recorder.layer)
          );

        const refused = yield* answer(
          new DriverError({ cause: new Error("schedule row refused") })
        );
        const missing = yield* answer(
          new NotFound({ error: "Workflow not found" })
        );

        assert.instanceOf(refused, InternalFailure);
        assert.strictEqual(refused.error, "Failed to execute workflow");
        assert.strictEqual(
          recorder.lines[0]?.message,
          "Failed to start workflow execution: schedule row refused"
        );
        assert.instanceOf(missing, NotFound);
        assert.strictEqual(recorder.lines.length, 1);
      })
  );
});
