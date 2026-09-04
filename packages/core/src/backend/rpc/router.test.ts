import { ORPCError } from "@orpc/server";
import {
  afterAll,
  assert,
  beforeEach,
  describe,
  expect,
  it,
} from "@effect/vitest";
import {
  Effect,
  Layer,
  Logger,
  ManagedRuntime,
  References,
  Stream,
} from "effect";
import { makeAgentConfigLayer } from "#src/backend/agent/config";
import {
  disabledAgentRunner,
  makeAgentRunnerLayer,
} from "#src/backend/agent/runner";
import { NotFound } from "#src/backend/lib/effect/failures";
import {
  SilentAppLoggerLayer,
  stubApiKeyRepo,
  stubExtensions,
  stubExecutionRepo,
  stubIntegrationRepo,
  stubInngestClient,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import { resetSync } from "@logtape/logtape";
import { configureLoggingWithBridge } from "#src/backend/lib/log-config";
import { createRequestEvent } from "#src/backend/lib/http/request-event";
import type { WfGraphRuntime } from "#src/backend/runtime";
import { rpcEffectHandler, rpcStreamHandler } from "#src/backend/rpc/router";
import { makeAppContextLayer } from "#src/backend/lib/effect/app-context";
import { createApiApp } from "#src/backend/api-app";
import {
  defineWfGraphAuth,
  resolveAuth,
  WfGraphAccess,
} from "#src/backend/lib/http/authorize";
import { rpcContract } from "@wfgraph/shared/rpc/contracts";

/**
 * A runtime satisfying every service a procedure may ask for, all of them
 * refusing.
 *
 * The handlers under test reach for none of them, and the refusals are what
 * says so. It has to provide the full set rather than an empty layer because
 * `WfGraphRuntime` is what a procedure's context carries, and a runtime built over
 * fewer services cannot stand in for one.
 */
function createStubRuntime({
  appContext = { apiBasePath: "/api" },
  effectLoggerLayer,
  startupLayer,
  integrationRepo,
  workflowRepo,
}: {
  appContext?: Parameters<typeof makeAppContextLayer>[0] | undefined;
  effectLoggerLayer?: Layer.Layer<never> | undefined;
  startupLayer?: Layer.Layer<never> | undefined;
  integrationRepo?: Parameters<typeof stubIntegrationRepo>[0] | undefined;
  workflowRepo?: Parameters<typeof stubWorkflowRepo>[0] | undefined;
} = {}): WfGraphRuntime {
  return ManagedRuntime.make(
    Layer.mergeAll(
      SilentAppLoggerLayer,
      effectLoggerLayer ?? Layer.empty,
      startupLayer ?? Layer.empty,
      makeAppContextLayer(appContext),
      stubExtensions(),
      stubApiKeyRepo(),
      stubIntegrationRepo(integrationRepo),
      stubWorkflowRepo(workflowRepo),
      stubExecutionRepo(),
      makeAgentConfigLayer({ enabled: false }),
      makeAgentRunnerLayer(disabledAgentRunner),
      stubInngestClient()
    )
  );
}

function createContext(runtime: WfGraphRuntime, signal?: AbortSignal) {
  return {
    context: {
      auth: {
        allows: () => Promise.resolve(true),
      },
      headers: new Headers(),
      runtime,
    },
    ...(signal ? { signal } : {}),
  };
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
  configureLoggingWithBridge({
    info: () => undefined,
    warn: (message) => {
      logLines.push(String(message));
    },
    error: (message) => {
      logLines.push(String(message));
    },
  });
});

// Back to unconfigured, which is logtape's own default and what every other
// file in this worker expects: the suite shares one module graph.
afterAll(() => {
  resetSync();
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
    await using runtime = createStubRuntime();
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
  });

  // A defect reaches oRPC's own bodyless 500, so the line naming it is the only
  // thing that tells whoever has to find the bug where it was.
  it("logs a defect once and still rejects", async () => {
    await using runtime = createStubRuntime();
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
      ["[wfgraph.rpc] RPC handler died: a bug inside a service"]
    );
  });

  /**
   * Served over HTTP the reason goes on the request's own record, which the
   * middleware writes once the status is known. Writing a line here as well
   * would report one refusal twice, which is what the request event exists to
   * stop.
   */
  it("puts a failure on the request event instead of logging its own line", async () => {
    await using runtime = createStubRuntime();
    const requestEvent = createRequestEvent();
    const handler = rpcEffectHandler(() =>
      Effect.fail(new NotFound({ error: "Workflow not found" }))
    );

    // oRPC hands the handler its input beside the context, and the failure
    // summary reads it off there. Declared rather than written inline,
    // because `rpcEffectHandler` types only the context member.
    const handlerArgs = {
      context: {
        auth: {
          allows: () => Promise.resolve(true),
        },
        headers: new Headers(),
        runtime,
        requestEvent,
      },
      input: { workflowId: "workflow_1" },
    };

    await handler(handlerArgs).catch(() => undefined);

    assert.deepStrictEqual(requestEvent.fields(), {
      error: {
        kind: "not_found",
        message: "Workflow not found",
        input: { workflowId: "workflow_1" },
      },
    });
    assert.deepStrictEqual(logLines, []);
  });
});

describe("rpcStreamHandler", () => {
  it("runs stream effects and finalizers through the managed runtime", async () => {
    const messages: unknown[] = [];
    const logger = Logger.make<unknown, void>(({ message }) => {
      messages.push(Array.isArray(message) ? message[0] : message);
    });
    await using runtime = createStubRuntime({
      effectLoggerLayer: Layer.merge(
        Logger.layer([logger]),
        Layer.succeed(References.MinimumLogLevel, "All")
      ),
    });
    const handler = rpcStreamHandler(() =>
      Effect.succeed(
        Stream.fromEffect(
          Effect.logInfo("stream effect").pipe(
            Effect.as("value"),
            Effect.ensuring(Effect.logInfo("stream finalizer"))
          )
        )
      )
    );

    const output = [];
    for await (const value of handler(createContext(runtime))) {
      output.push(value);
    }

    expect(output).toEqual(["value"]);
    expect(messages).toEqual(["stream effect", "stream finalizer"]);
  });

  it("maps a handler construction failure to an oRPC error", async () => {
    await using runtime = createStubRuntime();
    const handler = rpcStreamHandler(() =>
      Effect.fail(new NotFound({ error: "Workflow not found" }))
    );

    const rejection = await handler(createContext(runtime))
      .next()
      .then(
        () => undefined,
        (error: unknown) => error
      );

    assert.instanceOf(rejection, ORPCError);
    assert.strictEqual(rejection.code, "NOT_FOUND");
  });

  it("maps and records a failure produced after the stream starts", async () => {
    await using runtime = createStubRuntime();
    const requestEvent = createRequestEvent();
    const handler = rpcStreamHandler(
      (
        _input: ReturnType<typeof createContext> & {
          input: { workflowId: string };
        }
      ) =>
        Effect.succeed(
          Stream.fail(new NotFound({ error: "Workflow not found" }))
        )
    );
    const handlerArgs = {
      ...createContext(runtime),
      input: { workflowId: "workflow_1" },
      context: {
        ...createContext(runtime).context,
        requestEvent,
      },
    };
    const iterator = handler(handlerArgs);

    const rejection = await iterator.next().then(
      () => undefined,
      (error: unknown) => error
    );

    assert.instanceOf(rejection, ORPCError);
    assert.strictEqual(rejection.code, "NOT_FOUND");
    assert.deepStrictEqual(requestEvent.fields(), {
      error: {
        kind: "not_found",
        message: "Workflow not found",
        input: { workflowId: "workflow_1" },
      },
    });
  });

  it("rejects the active next call when the running stream dies", async () => {
    await using runtime = createStubRuntime();
    const defect = new Error("stream defect");
    const handler = rpcStreamHandler(() =>
      Effect.succeed(Stream.fromEffect(Effect.die(defect)))
    );

    const rejection = await handler(createContext(runtime))
      .next()
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(rejection).toBe(defect);
  });

  it("cancels while next is waiting for a stream value", async () => {
    await using runtime = createStubRuntime();
    const started = Promise.withResolvers<void>();
    const handler = rpcStreamHandler(() =>
      Effect.succeed(
        Stream.fromEffect(
          Effect.sync(() => started.resolve()).pipe(
            Effect.andThen(Effect.never)
          )
        )
      )
    );
    const iterator = handler(createContext(runtime));
    const pendingNext = iterator.next();
    await started.promise;

    const returnResult = await Promise.race([
      iterator.return(),
      new Promise<"timed-out">((resolve) => {
        setTimeout(() => resolve("timed-out"), 500);
      }),
    ]);

    expect(returnResult).toEqual({ done: true, value: undefined });
    await expect(pendingNext).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("throws promptly while next is waiting for a stream value", async () => {
    await using runtime = createStubRuntime();
    const started = Promise.withResolvers<void>();
    const handler = rpcStreamHandler(() =>
      Effect.succeed(
        Stream.fromEffect(
          Effect.sync(() => started.resolve()).pipe(
            Effect.andThen(Effect.never)
          )
        )
      )
    );
    const iterator = handler(createContext(runtime));
    const pendingNext = iterator.next();
    const cancellation = new Error("client cancelled");
    await started.promise;

    const throwResult = await Promise.race([
      iterator.throw(cancellation).catch((error: unknown) => error),
      new Promise<"timed-out">((resolve) => {
        setTimeout(() => resolve("timed-out"), 500);
      }),
    ]);

    expect(throwResult).toBe(cancellation);
    await expect(pendingNext).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("interrupts and finalizes a stream when the request aborts during next", async () => {
    await using runtime = createStubRuntime();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const finalized = Promise.withResolvers<void>();
    const handler = rpcStreamHandler(() =>
      Effect.succeed(
        Stream.fromEffect(
          Effect.sync(() => started.resolve()).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.sync(() => finalized.resolve()))
          )
        )
      )
    );
    const iterator = handler(createContext(runtime, controller.signal));
    const pendingNext = iterator.next();
    await started.promise;

    controller.abort();

    await expect(
      Promise.race([
        pendingNext,
        new Promise<"timed-out">((resolve) => {
          setTimeout(() => resolve("timed-out"), 500);
        }),
      ])
    ).resolves.toEqual({ done: true, value: undefined });
    await finalized.promise;
  });

  it("does not start a producer for a request aborted before next", async () => {
    await using runtime = createStubRuntime();
    const controller = new AbortController();
    controller.abort();
    let producerStarted = false;
    const handler = rpcStreamHandler(() => {
      producerStarted = true;
      return Effect.succeed(Stream.fromIterable(["value"]));
    });
    const iterator = handler(createContext(runtime, controller.signal));

    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(producerStarted).toBe(false);
  });

  it("waits for each emitted value to be consumed", async () => {
    await using runtime = createStubRuntime();
    let produced = 0;
    const handler = rpcStreamHandler(() =>
      Effect.succeed(
        Stream.fromEffectRepeat(
          Effect.sync(() => {
            produced += 1;
            return produced;
          })
        )
      )
    );
    const iterator = handler(createContext(runtime));

    await expect(iterator.next()).resolves.toEqual({ done: false, value: 1 });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(produced).toBe(2);
    await iterator.return();
  });

  it("runs the stream finalizer when the iterator is returned", async () => {
    await using runtime = createStubRuntime();
    const started = Promise.withResolvers<void>();
    const finalized = Promise.withResolvers<void>();
    const handler = rpcStreamHandler(() =>
      Effect.succeed(
        Stream.fromEffect(
          Effect.sync(() => started.resolve()).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.sync(() => finalized.resolve()))
          )
        )
      )
    );
    const iterator = handler(createContext(runtime));
    const pendingNext = iterator.next();
    await started.promise;

    await iterator.return();
    await finalized.promise;
    await pendingNext;
  });

  it("interrupts the stream when the managed runtime is disposed", async () => {
    const runtime = createStubRuntime();
    const started = Promise.withResolvers<void>();
    const finalized = Promise.withResolvers<void>();
    const handler = rpcStreamHandler(() =>
      Effect.succeed(
        Stream.fromEffect(
          Effect.sync(() => started.resolve()).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.sync(() => finalized.resolve()))
          )
        )
      )
    );
    const iterator = handler(createContext(runtime));
    const pendingNext = iterator.next();
    const nextSettled = pendingNext.catch(() => undefined);
    await started.promise;

    await runtime.dispose();

    await finalized.promise;
    await nextSettled;
  });

  it("settles next when runtime disposal interrupts initial layer construction", async () => {
    const runtime = createStubRuntime({
      startupLayer: Layer.effectContext(Effect.never),
    });
    const handler = rpcStreamHandler(() =>
      Effect.succeed(Stream.fromIterable(["value"]))
    );
    const pendingNext = handler(createContext(runtime)).next();

    await runtime.dispose();

    await expect(
      Promise.race([
        pendingNext,
        new Promise<"timed-out">((resolve) => {
          setTimeout(() => resolve("timed-out"), 500);
        }),
      ])
    ).resolves.toEqual({ done: true, value: undefined });
  });

  it("settles next when initial layer construction fails", async () => {
    const layerError = new Error("layer startup failed");
    await using runtime = createStubRuntime({
      startupLayer: Layer.effectContext(Effect.die(layerError)),
    });
    const handler = rpcStreamHandler(() =>
      Effect.succeed(Stream.fromIterable(["value"]))
    );

    await expect(handler(createContext(runtime)).next()).rejects.toBe(
      layerError
    );
  });
});

describe("workflow draft subscription RPC", () => {
  it("resumes after the last event id and emits the revision as SSE metadata", async () => {
    let read = 0;
    await using runtime = createStubRuntime({
      workflowRepo: {
        findDraftRevisionById: () => {
          read += 1;
          return Effect.succeed({
            id: "workflow_1",
            draftRevision: read === 1 ? 6 : 7,
          });
        },
      },
    });
    const app = createApiApp({
      basePath: "/api",
      auth: resolveAuth(defineWfGraphAuth(() => WfGraphAccess.all)),
      runtime,
    });

    const response = await app.fetch(
      new Request("http://localhost/api/rpc/workflow/subscribeDraft", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "last-event-id": "6",
        },
        body: JSON.stringify({
          json: { workflowId: "workflow_1", afterDraftRevision: 1 },
        }),
      })
    );
    const reader = response.body?.getReader();
    assert.isDefined(reader);
    const decoder = new TextDecoder();
    let body = "";

    while (!body.includes("event: message")) {
      const chunk = await reader.read();
      assert.isFalse(chunk.done);
      body += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel();

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("id: 7");
    expect(body).toContain('"draftRevision":7');
  });
});

describe("integration OAuth RPC", () => {
  it("routes disconnectOAuth through the integration service", async () => {
    await using runtime = createStubRuntime({
      appContext: {
        apiBasePath: "/api",
        publicUrl: "https://workflows.example.com",
      },
      integrationRepo: { findById: () => Effect.succeed(null) },
    });
    const app = createApiApp({
      basePath: "/api",
      auth: resolveAuth(defineWfGraphAuth(() => WfGraphAccess.all)),
      runtime,
    });

    const response = await app.fetch(
      new Request("http://localhost/api/rpc/integration/disconnectOAuth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { integrationId: "int_1" } }),
      })
    );

    assert.strictEqual(response.status, 404);
  });
});

describe("operation authorization", () => {
  it("fails closed before a handler runs when a procedure has no operation metadata", async () => {
    let handlerRan = false;
    const runtime = createStubRuntime({
      workflowRepo: {
        listSummariesNewestFirst: Effect.sync(() => {
          handlerRan = true;
          return [];
        }),
      },
    });
    const procedure = rpcContract.workflow.getAll as unknown as {
      "~orpc": { meta: Record<string, unknown> };
    };
    const metadata = procedure["~orpc"].meta;
    const operation = metadata["wfgraph.operation"];
    Reflect.deleteProperty(metadata, "wfgraph.operation");
    const app = createApiApp({
      basePath: "/api",
      auth: resolveAuth(defineWfGraphAuth(() => WfGraphAccess.all)),
      runtime,
    });

    try {
      const response = await app.fetch(
        new Request("http://localhost/api/rpc/workflow/getAll", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: {} }),
        })
      );

      assert.strictEqual(response.status, 500);
      assert.isFalse(handlerRan);
    } finally {
      metadata["wfgraph.operation"] = operation;
      await runtime.dispose();
    }
  });

  it("refuses protected RPC and REST operations after authentication", async () => {
    await using runtime = createStubRuntime();
    let authentications = 0;
    const app = createApiApp({
      basePath: "/api",
      auth: resolveAuth(
        defineWfGraphAuth(() => {
          authentications += 1;
          return { allows: () => false };
        })
      ),
      runtime,
    });

    const rpcResponse = await app.fetch(
      new Request("http://localhost/api/rpc/workflow/getAll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      })
    );
    const restResponse = await app.fetch(
      new Request("http://localhost/api/rest/workflows")
    );

    expect(rpcResponse.status).toBe(403);
    expect(restResponse.status).toBe(403);
    expect(authentications).toBe(2);
  });

  it.each([
    {
      name: "authentication callback",
      auth: defineWfGraphAuth(() => {
        throw new Error("private session-store detail");
      }),
    },
    {
      name: "access policy",
      auth: defineWfGraphAuth(() => ({
        allows: () => {
          throw new Error("private policy-store detail");
        },
      })),
    },
  ])("returns a sanitized 500 when the $name fails", async ({ auth }) => {
    await using runtime = createStubRuntime();
    const app = createApiApp({
      basePath: "/api",
      auth: resolveAuth(auth),
      runtime,
    });

    const response = await app.fetch(
      new Request("http://localhost/api/rpc/workflow/getAll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      })
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain("private");
    expect(body).not.toContain("session-store");
    expect(body).not.toContain("policy-store");
  });
});
