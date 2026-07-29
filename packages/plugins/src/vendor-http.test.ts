import { assert, describe, expect, it } from "@effect/vitest";
import { afterEach, beforeEach } from "vitest";
import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { VendorTransport } from "@rova/core/plugin";
import {
  callVendor,
  parsePayload,
  type VendorError,
  VendorRejected,
  type VendorRequest,
  VendorUnreadable,
} from "#src/vendor-http";

const realFetch = globalThis.fetch;
let requests: Request[] = [];

function stubFetch(
  respond: (request: Request) => Response | Promise<Response>
): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(respond(request));
  }) as typeof fetch;
}

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const thing = Schema.Struct({ id: Schema.String });

const request: VendorRequest<typeof thing> = {
  vendor: "Vendor",
  url: "https://vendor.example/things",
  method: "POST",
  headers: { authorization: "Bearer k" },
  schema: thing,
};

function call<S extends Schema.ConstraintDecoder<unknown>>(
  spec: VendorRequest<S>
): Effect.Effect<S["Type"], VendorError> {
  return callVendor(spec).pipe(Effect.provide(VendorTransport));
}

/**
 * The failure a call ended in, for a test that expects one. A call that
 * succeeds fails the flip instead, which is what makes the test say so.
 */
function failure<S extends Schema.ConstraintDecoder<unknown>>(
  spec: VendorRequest<S>
): Effect.Effect<VendorError, S["Type"]> {
  return Effect.flip(call(spec));
}

/**
 * The two narrowings a test needs before it can read a status off a failure.
 * `instanceof` is what tells the compiler which of the three it is holding.
 */
function refusal(error: VendorError): VendorRejected {
  if (error instanceof VendorRejected) {
    return error;
  }
  throw new Error(`expected a refusal, got ${error._tag}`);
}

function unreadable(error: VendorError): VendorUnreadable {
  if (error instanceof VendorUnreadable) {
    return error;
  }
  throw new Error(`expected an unreadable body, got ${error._tag}`);
}

/**
 * Lets the pending fetch promises settle.
 *
 * `TestClock.adjust` only wakes a sleep that has already been scheduled, and
 * everything before that sleep is a real promise chain, so a test that advances
 * the clock has to let the microtask queue drain first. `setImmediate` runs
 * after all of it and takes no part in the clock the retries sleep on.
 */
const settle = Effect.promise(
  () => new Promise<void>((resolve) => setImmediate(resolve))
);

describe("callVendor", () => {
  it("passes the method, headers, and body through", async () => {
    stubFetch(() => Response.json({ id: "1" }));

    await Effect.runPromise(
      call({ ...request, body: { kind: "json", value: { hello: "there" } } })
    );

    const sent = requests[0];
    expect(sent?.url).toBe("https://vendor.example/things");
    expect(sent?.method).toBe("POST");
    expect(sent?.headers.get("authorization")).toBe("Bearer k");
    expect(await sent?.text()).toBe(JSON.stringify({ hello: "there" }));
  });

  it("sends an idempotency key as the header the vendors read", async () => {
    stubFetch(() => Response.json({ id: "1" }));

    await Effect.runPromise(call({ ...request, idempotencyKey: "exec_42" }));

    expect(requests[0]?.headers.get("idempotency-key")).toBe("exec_42");
  });

  it("decodes the body the caller asked for", async () => {
    stubFetch(() => Response.json({ id: "1", extra: true }, { status: 201 }));

    expect(await Effect.runPromise(call(request))).toEqual({ id: "1" });
  });

  it("keeps a failure status as a refusal carrying the vendor's body", async () => {
    stubFetch(() => Response.json({ message: "nope" }, { status: 422 }));

    const error = refusal(await Effect.runPromise(failure(request)));

    assert.strictEqual(error.status, 422);
    assert.deepStrictEqual(error.payload, { message: "nope" });
  });

  // A 204, an empty body, and HTML from a proxy in front of the vendor all read
  // as no payload at all. The status is then the whole story: a success status
  // with nothing to decode is unreadable, a failure status is a bare refusal.
  it("finds no payload when there is no JSON body", async () => {
    for (const response of [
      () => new Response(null, { status: 204 }),
      () => new Response("", { status: 200 }),
    ]) {
      stubFetch(response);
      const error = unreadable(await Effect.runPromise(failure(request)));
      assert.isTrue(error.status === 204 || error.status === 200);
    }

    stubFetch(() => new Response("<html>gateway</html>", { status: 502 }));
    const error = refusal(await Effect.runPromise(failure(request)));

    assert.strictEqual(error.status, 502);
    assert.strictEqual(error.payload, undefined);
  });

  // Reporting success on a body we could not read would hand the run an empty
  // id and call it sent.
  it("refuses a success status that is not the documented shape", async () => {
    stubFetch(() => Response.json({ unexpected: true }));

    const error = unreadable(await Effect.runPromise(failure(request)));

    assert.strictEqual(error.status, 200);
  });

  // The distinction that matters: nothing answered, so there is no status to
  // report and nothing for a caller to read a slug out of.
  it("reports a request that never arrived", async () => {
    stubFetch(() => Promise.reject(new Error("ECONNREFUSED")));

    const error = await Effect.runPromise(failure(request));

    assert.strictEqual(error._tag, "VendorUnreachable");
    assert.strictEqual(error.message, "ECONNREFUSED");
  });

  it("carries a non-Error rejection through as text", async () => {
    stubFetch(() => Promise.reject("timeout"));

    const error = await Effect.runPromise(failure(request));

    assert.strictEqual(error._tag, "VendorUnreachable");
    assert.strictEqual(error.message, "timeout");
  });

  it("reads a refusal out of a success body when the vendor puts one there", async () => {
    stubFetch(() => Response.json({ ok: false, error: "invalid_auth" }));

    const error = refusal(
      await Effect.runPromise(
        failure({ ...request, refusedInBody: () => true })
      )
    );

    assert.strictEqual(error.status, 200);
  });
});

describe("the timeout", () => {
  it.effect("calls a vendor that never answers unreachable", () =>
    Effect.gen(function* () {
      stubFetch(() => new Promise<Response>(() => undefined));

      const fiber = yield* Effect.forkChild(failure(request));
      yield* settle;
      yield* TestClock.adjust("10 seconds");

      const error = yield* Fiber.join(fiber);

      assert.strictEqual(error._tag, "VendorUnreachable");
      assert.strictEqual(error.message, "Vendor did not answer within 10s");
    })
  );
});

/**
 * The retry policy lives in `vendor-http.ts` and is stated in the comment above
 * `RETRY_ATTEMPTS`. These pin the decisions in it: what is retried, how long the
 * wait is, that a `Retry-After` in the form the RFC gives replaces that wait,
 * how long the loop as a whole may run, and that a request a repeat could do
 * twice is not retried at all.
 */
describe("the retry policy", () => {
  const readable: VendorRequest<typeof thing> = {
    ...request,
    method: "GET",
  };

  function respondTimes(
    failures: number,
    failWith: () => Response
  ): { attempts: () => number } {
    let attempts = 0;
    stubFetch(() => {
      attempts += 1;
      return attempts <= failures ? failWith() : Response.json({ id: "1" });
    });
    return { attempts: () => attempts };
  }

  it.effect("waits out a Retry-After and comes back", () =>
    Effect.gen(function* () {
      const stub = respondTimes(
        1,
        () =>
          new Response("{}", { status: 429, headers: { "retry-after": "3" } })
      );

      const fiber = yield* Effect.forkChild(call(readable));
      yield* settle;
      assert.strictEqual(stub.attempts(), 1);

      // Two seconds into the three the vendor asked for, nothing has moved.
      yield* TestClock.adjust("2 seconds");
      yield* settle;
      assert.strictEqual(stub.attempts(), 1);

      yield* TestClock.adjust("1 second");
      yield* settle;

      assert.deepStrictEqual(yield* Fiber.join(fiber), { id: "1" });
      assert.strictEqual(stub.attempts(), 2);
    })
  );

  // Without a Retry-After the wait is 500ms exponential with jitter, which
  // scales each delay by a factor between 0.8 and 1.2.
  it.effect("backs off within the jitter band when no delay was named", () =>
    Effect.gen(function* () {
      const stub = respondTimes(1, () => new Response("", { status: 503 }));

      const fiber = yield* Effect.forkChild(call(readable));
      yield* settle;

      yield* TestClock.adjust("399 millis");
      yield* settle;
      assert.strictEqual(stub.attempts(), 1);

      yield* TestClock.adjust("202 millis");
      yield* settle;

      assert.deepStrictEqual(yield* Fiber.join(fiber), { id: "1" });
      assert.strictEqual(stub.attempts(), 2);
    })
  );

  it.effect("gives up after two retries", () =>
    Effect.gen(function* () {
      const stub = respondTimes(9, () => new Response("", { status: 503 }));

      const fiber = yield* Effect.forkChild(failure(readable));
      yield* settle;

      // A second at a time, because the elapsed budget is read off this same
      // clock: one minute-long jump would spend the whole of it between the
      // first failure and the second, and the third attempt would never happen.
      yield* TestClock.adjust("1 second");
      yield* settle;
      yield* TestClock.adjust("2 seconds");
      yield* settle;

      const error = yield* Fiber.join(fiber);

      assert.strictEqual(error._tag, "VendorRejected");
      assert.strictEqual(stub.attempts(), 3);
    })
  );

  // The budget is read when a failure arrives, so it bounds the time the loop
  // has already spent: a ten-second wait and then an attempt that hangs to its
  // own timeout has used all of it, and there is no third attempt.
  it.effect("abandons a retry the budget can no longer fit", () =>
    Effect.gen(function* () {
      let attempts = 0;
      stubFetch(() => {
        attempts += 1;
        return attempts === 1
          ? new Response("{}", {
              status: 429,
              headers: { "retry-after": "10" },
            })
          : new Promise<Response>(() => undefined);
      });

      const fiber = yield* Effect.forkChild(failure(readable));
      yield* settle;

      // The wait the vendor asked for, then the attempt after it hanging until
      // the per-attempt timeout fires.
      yield* TestClock.adjust("10 seconds");
      yield* settle;
      yield* TestClock.adjust("10 seconds");
      yield* settle;

      const error = yield* Fiber.join(fiber);

      assert.strictEqual(error._tag, "VendorUnreachable");
      assert.strictEqual(attempts, 2);
    })
  );

  // RFC 9110 writes delta-seconds as digits and nothing else. `Number` reads
  // three of these as numbers anyway, and the empty one, which is what a
  // whitespace-only header becomes, as a zero: that zero would make a bare 500
  // retryable and then name no delay at all.
  it.effect("ignores a Retry-After that is not delta-seconds", () =>
    Effect.gen(function* () {
      for (const value of ["", " ", "1e3", "0x10"]) {
        const stub = respondTimes(
          9,
          () =>
            new Response("", {
              status: 500,
              headers: { "retry-after": value },
            })
        );

        const fiber = yield* Effect.forkChild(failure(readable));
        yield* settle;
        yield* TestClock.adjust("1 second");
        yield* settle;

        yield* Fiber.join(fiber);

        assert.strictEqual(stub.attempts(), 1);
      }
    })
  );

  // A 429 is retried on its own account, so an unreadable header leaves the
  // backoff in place. Reading "1e3" as a thousand seconds would instead put the
  // delay past the ceiling and end the call on its first attempt.
  it.effect("backs off as usual when a Retry-After cannot be read", () =>
    Effect.gen(function* () {
      const stub = respondTimes(
        1,
        () =>
          new Response("{}", { status: 429, headers: { "retry-after": "1e3" } })
      );

      const fiber = yield* Effect.forkChild(call(readable));
      yield* settle;
      yield* TestClock.adjust("1 second");
      yield* settle;

      assert.deepStrictEqual(yield* Fiber.join(fiber), { id: "1" });
      assert.strictEqual(stub.attempts(), 2);
    })
  );

  it.effect("does not retry a write that has no idempotency key", () =>
    Effect.gen(function* () {
      const stub = respondTimes(9, () => new Response("", { status: 503 }));

      const fiber = yield* Effect.forkChild(failure(request));
      yield* settle;
      yield* TestClock.adjust("1 minute");
      yield* settle;

      yield* Fiber.join(fiber);

      assert.strictEqual(stub.attempts(), 1);
    })
  );

  it.effect("retries a write that carries an idempotency key", () =>
    Effect.gen(function* () {
      const stub = respondTimes(1, () => new Response("", { status: 503 }));

      const fiber = yield* Effect.forkChild(
        call({ ...request, idempotencyKey: "exec_42" })
      );
      yield* settle;
      yield* TestClock.adjust("1 second");
      yield* settle;

      assert.deepStrictEqual(yield* Fiber.join(fiber), { id: "1" });
      assert.strictEqual(stub.attempts(), 2);
    })
  );

  // A vendor asking for a longer wait than this module will sit through is not
  // having a hiccup, so the failure goes out to the engine instead.
  it.effect("does not wait out a Retry-After past the ceiling", () =>
    Effect.gen(function* () {
      const stub = respondTimes(
        9,
        () =>
          new Response("{}", { status: 429, headers: { "retry-after": "600" } })
      );

      const fiber = yield* Effect.forkChild(failure(readable));
      yield* settle;
      yield* TestClock.adjust("1 hour");
      yield* settle;

      yield* Fiber.join(fiber);

      assert.strictEqual(stub.attempts(), 1);
    })
  );

  // A 500 on its own is as often a deterministic refusal as a hiccup.
  it.effect("leaves a plain 500 alone", () =>
    Effect.gen(function* () {
      const stub = respondTimes(9, () => new Response("", { status: 500 }));

      const fiber = yield* Effect.forkChild(failure(readable));
      yield* settle;
      yield* TestClock.adjust("1 minute");
      yield* settle;

      yield* Fiber.join(fiber);

      assert.strictEqual(stub.attempts(), 1);
    })
  );
});

describe("parsePayload", () => {
  const schema = Schema.Struct({ id: Schema.String });

  it("returns the parsed value when the payload matches", () => {
    expect(parsePayload({ id: "1", extra: true }, schema)).toEqual({ id: "1" });
  });

  it("returns undefined for a payload of the wrong shape", () => {
    expect(parsePayload({ id: 1 }, schema)).toBeUndefined();
    expect(parsePayload(["1"], schema)).toBeUndefined();
    expect(parsePayload("1", schema)).toBeUndefined();
    expect(parsePayload(undefined, schema)).toBeUndefined();
  });
});
