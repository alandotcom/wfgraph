import { afterAll, assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import type {
  EffectLogger,
  LogProperties,
} from "#src/backend/lib/effect/app-logger";
import {
  DatabaseError,
  internalFailure,
} from "#src/backend/lib/effect/database";
import {
  Conflict,
  InternalFailure,
  InvalidInput,
  NotFound,
  type ServiceFailure,
  Unauthorized,
} from "#src/backend/lib/effect/failures";
import type { ServiceFailureKind } from "#src/backend/lib/service-result";
import { createRovaRuntime, runToServiceResult } from "#src/backend/runtime";

/**
 * The seam every migrated service answers through.
 *
 * The two edge adapters read the `kind` this produces and turn it into an oRPC
 * code and an HTTP status, so a failure class whose kind drifted would change
 * what a caller receives without changing anything those adapters can see.
 */
describe("runToServiceResult", () => {
  const runtime = createRovaRuntime();
  afterAll(async () => await runtime.dispose());

  const failures: Array<[ServiceFailure, ServiceFailureKind]> = [
    [new InvalidInput({ error: "Graph is malformed" }), "invalid"],
    [new Unauthorized({ error: "Invalid API key" }), "unauthorized"],
    [new NotFound({ error: "API key not found" }), "not_found"],
    [new Conflict({ error: "Name already taken" }), "conflict"],
    [new InternalFailure({ error: "Failed to list API keys" }), "internal"],
  ];

  it("carries a success through unchanged", async () => {
    const result = await runToServiceResult(
      runtime,
      Effect.succeed({ id: "wf_1" })
    );

    assert.deepStrictEqual(result, { ok: true, data: { id: "wf_1" } });
  });

  it.each(failures)(
    "maps a failure to the kind the edge adapters read",
    async (failure, kind) => {
      const result = await runToServiceResult(runtime, Effect.fail(failure));

      assert.deepStrictEqual(result, {
        ok: false,
        kind,
        error: { error: failure.error },
      });
    }
  );
});

describe("internalFailure", () => {
  const runtime = createRovaRuntime();
  afterAll(async () => await runtime.dispose());

  it("logs the underlying error and answers with the caller's message", async () => {
    const lines: Array<{ message: string; properties?: LogProperties }> = [];
    const recorder: EffectLogger = {
      debug: () => Effect.void,
      info: () => Effect.void,
      warn: () => Effect.void,
      error: (message, properties) =>
        Effect.sync(() => {
          lines.push({ message, properties });
        }),
      with: () => recorder,
    };

    const cause = new Error("connection refused");
    const result = await runToServiceResult(
      runtime,
      Effect.fail(new DatabaseError({ cause })).pipe(
        Effect.catchTag(
          "DatabaseError",
          internalFailure(recorder, "Failed to list API keys")
        )
      )
    );

    assert.deepStrictEqual(result, {
      ok: false,
      kind: "internal",
      error: { error: "Failed to list API keys" },
    });
    assert.deepStrictEqual(lines, [
      {
        message: "Failed to list API keys: connection refused",
        properties: { error: cause },
      },
    ]);
  });
});
