import { ORPCError } from "@orpc/server";
import { afterAll, assert, beforeEach, describe, it } from "@effect/vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import { NotFound } from "#src/backend/lib/effect/failures";
import {
  SilentAppLoggerLayer,
  stubApiKeyRepo,
  stubExecutionRepo,
  stubIntegrationRepo,
  stubInngestClient,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import {
  configureAppLogging,
  configureAppLoggingWithBridge,
} from "#src/backend/lib/logger";
import type { RovaRuntime } from "#src/backend/runtime";
import { rpcEffectHandler } from "#src/backend/rpc/router";

/**
 * A runtime satisfying every service a procedure may ask for, all of them
 * refusing.
 *
 * The handlers under test reach for none of them, and the refusals are what
 * says so. It has to provide the full set rather than an empty layer because
 * `RovaRuntime` is what a procedure's context carries, and a runtime built over
 * fewer services cannot stand in for one.
 */
function createStubRuntime(): RovaRuntime {
  return ManagedRuntime.make(
    Layer.mergeAll(
      SilentAppLoggerLayer,
      stubApiKeyRepo(),
      stubIntegrationRepo(),
      stubWorkflowRepo(),
      stubExecutionRepo(),
      stubInngestClient()
    )
  );
}

function createContext(runtime: RovaRuntime) {
  return { context: { headers: new Headers(), runtime } };
}

/**
 * The lines the handler wrote, read off logtape itself.
 *
 * The failure and defect logs go to this module's own logtape logger rather
 * than through `AppLogger`, so the bridge sink is where a test can see them.
 */
const logLines: string[] = [];

beforeEach(() => {
  logLines.length = 0;
  configureAppLoggingWithBridge({
    info: () => undefined,
    warn: (message) => {
      logLines.push(String(message));
    },
    error: (message) => {
      logLines.push(String(message));
    },
  });
});

afterAll(() => {
  configureAppLogging();
});

describe("rpcEffectHandler", () => {
  /**
   * The load-bearing claim about the Effect beta this package pins: a failure
   * carrying an `ORPCError` comes back out of `runPromise` as that same object,
   * because the runner squashes a failure cause down to the error itself. oRPC
   * then catches what it would have caught from a `throw`, and the client reads
   * the code and the data off it. An upgrade that changed the squash would break
   * every procedure's error response, and this is what would catch it.
   */
  it("rejects with the oRPC error a domain failure maps to", async () => {
    const runtime = createStubRuntime();
    try {
      const handler = rpcEffectHandler(() =>
        Effect.fail(new NotFound({ error: "Workflow not found" }))
      );

      const rejection = await handler(createContext(runtime)).then(
        () => undefined,
        (error: unknown) => error
      );

      assert.instanceOf(rejection, ORPCError);
      assert.strictEqual(rejection.code, "NOT_FOUND");
      assert.deepStrictEqual(rejection.data, {
        error: "Workflow not found",
      });
    } finally {
      await runtime.dispose();
    }
  });

  // A defect reaches oRPC's own bodyless 500, so the line naming it is the only
  // thing that tells whoever has to find the bug where it was.
  it("logs a defect once and still rejects", async () => {
    const runtime = createStubRuntime();
    try {
      const handler = rpcEffectHandler(() =>
        Effect.die(new Error("a bug inside a service"))
      );

      const rejection = await handler(createContext(runtime)).then(
        () => undefined,
        (error: unknown) => error
      );

      assert.isDefined(rejection);
      assert.deepStrictEqual(
        logLines.filter((line) => line.includes("RPC handler died")),
        ["[app.rpc.handler] RPC handler died: a bug inside a service"]
      );
    } finally {
      await runtime.dispose();
    }
  });
});
