import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { InngestError } from "#src/backend/lib/effect/inngest-client";
import { InternalFailure } from "#src/backend/lib/effect/failures";
import {
  internalFailure,
  internalFailureRelayingCause,
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

describe("internalFailureRelayingCause", () => {
  it("hands the underlying message to the caller", async () => {
    const recorder = makeRecordingLogger();
    const cause = new Error("duplicate key value violates unique constraint");

    const failure = await Effect.runPromise(
      Effect.fail(new DatabaseError({ cause })).pipe(
        Effect.catchTag(
          "DatabaseError",
          internalFailureRelayingCause(
            Effect.succeed(recorder.logger),
            "Failed to save current workflow"
          )
        ),
        Effect.flip,
        Effect.provide(recorder.layer)
      )
    );

    assert.instanceOf(failure, InternalFailure);
    assert.strictEqual(
      failure.error,
      "duplicate key value violates unique constraint"
    );
    assert.deepStrictEqual(recorder.lines, [
      {
        message:
          "Failed to save current workflow: duplicate key value violates unique constraint",
        properties: { error: cause },
      },
    ]);
  });

  // The entrypoints whose two sentences were never the same one: the operator
  // greps for the log line, the caller is told what they asked for failed.
  it("falls back to the caller's own message when nothing was thrown", async () => {
    const recorder = makeRecordingLogger();

    const failure = await Effect.runPromise(
      Effect.fail(new DatabaseError({ cause: "connection lost" })).pipe(
        Effect.catchTag(
          "DatabaseError",
          internalFailureRelayingCause(
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
          internalFailureRelayingCause(
            Effect.succeed(recorder.logger),
            "Failed to cancel execution"
          )
        ),
        Effect.flip,
        Effect.provide(recorder.layer)
      )
    );

    assert.strictEqual(failure.error, "inngest dev server unreachable");
    assert.strictEqual(
      recorder.lines[0]?.message,
      "Failed to cancel execution: inngest dev server unreachable"
    );
  });
});
