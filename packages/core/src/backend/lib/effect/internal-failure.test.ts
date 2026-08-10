import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { InngestError } from "#src/backend/lib/effect/inngest-client";
import { InternalFailure } from "#src/backend/lib/effect/failures";
import {
  internalFailure,
  internalFailureFromCause,
} from "#src/backend/lib/effect/internal-failure";
import { makeRecordingLogger } from "#src/backend/lib/effect/test-layers";

describe("internalFailure", () => {
  it("logs the underlying error and answers with the caller's message", async () => {
    const recorder = makeRecordingLogger();
    const cause = new Error("connection refused");

    const failure = await Effect.runPromise(
      Effect.fail(new DatabaseError({ cause })).pipe(
        Effect.catchTag(
          "DatabaseError",
          internalFailure(recorder.logger, "Failed to list API keys")
        ),
        Effect.flip
      )
    );

    assert.instanceOf(failure, InternalFailure);
    assert.strictEqual(failure.error, "Failed to list API keys");
    assert.deepStrictEqual(recorder.lines, [
      {
        message: "Failed to list API keys: connection refused",
        properties: { error: cause },
      },
    ]);
  });
});

describe("internalFailureFromCause", () => {
  it("keeps the underlying message in the log and out of the caller response", async () => {
    const recorder = makeRecordingLogger();
    const cause = new Error("duplicate key value violates unique constraint");

    const failure = await Effect.runPromise(
      Effect.fail(new DatabaseError({ cause })).pipe(
        Effect.catchTag(
          "DatabaseError",
          internalFailureFromCause(
            Effect.succeed(recorder.logger),
            "Failed to save current workflow"
          )
        ),
        Effect.flip,
        Effect.provide(recorder.layer)
      )
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
  });

  // The entrypoints whose two sentences differ: the operator greps for the log
  // line, while the caller is told what they asked for failed.
  it("uses the caller's own message", async () => {
    const recorder = makeRecordingLogger();

    const failure = await Effect.runPromise(
      Effect.fail(new DatabaseError({ cause: "connection lost" })).pipe(
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
      )
    );

    assert.strictEqual(failure.error, "Failed to execute workflow");
    assert.strictEqual(
      recorder.lines[0]?.message,
      "Failed to start workflow execution: connection lost"
    );
  });

  // One policy covers both seams, which is why it reads `cause` rather than
  // naming the class it came from.
  it("answers a refused Inngest send the same way", async () => {
    const recorder = makeRecordingLogger();
    const cause = new Error("inngest dev server unreachable");

    const failure = await Effect.runPromise(
      Effect.fail(new InngestError({ cause })).pipe(
        Effect.catchTag(
          "InngestError",
          internalFailureFromCause(
            Effect.succeed(recorder.logger),
            "Failed to cancel execution"
          )
        ),
        Effect.flip,
        Effect.provide(recorder.layer)
      )
    );

    assert.strictEqual(failure.error, "Failed to cancel execution");
    assert.strictEqual(
      recorder.lines[0]?.message,
      "Failed to cancel execution: inngest dev server unreachable"
    );
  });
});
