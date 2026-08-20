/**
 * What goes on the wire, against PostHog's own capture and flags endpoints.
 *
 * Every refusal body below was recorded from US Cloud rather than written from
 * the reference, because the two endpoints refuse differently and the
 * difference is the whole reason the connection test goes where it does.
 *
 * The retry case is the load-bearing one. The capture call is marked
 * `safeToRepeat` on the promise that its body is fixed before the first attempt,
 * and the assertion that both attempts carried identical bytes is what holds
 * that promise honest.
 */

import { ExternalTransport, ExternalUnreachable } from "@wfgraph/core/plugin";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, beforeEach } from "vitest";
import {
  captureEvent,
  describePostHogFailure,
  evaluateFlags,
  readPostHogError,
  resolvePostHogHost,
} from "#src/posthog/client";

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

/** A call that succeeds fails the flip, which is what makes the test say so. */
const failure = Effect.flip;

const withTransport = Effect.provide(ExternalTransport);

const CONNECTION = {
  projectApiKey: "phc_key",
  host: "https://us.i.posthog.com",
};

const EVENT = {
  event: "user_signed_up",
  distinct_id: "user_1",
  uuid: "0192f0c3-0000-7000-8000-000000000001",
  timestamp: "2024-12-25T09:00:00.000Z",
  properties: { plan: "pro" },
};

/** The refusal a bad project key earns from the flags route, as recorded. */
const INVALID_KEY_BODY = {
  type: "authentication_error",
  code: "authentication_failed",
  detail:
    "The provided API key is invalid or has expired. Please check your API key and try again.",
  attr: null,
};

/** The body of one recorded request, parsed. */
function readBody(index: number): Effect.Effect<unknown> {
  return Effect.promise(() => {
    const request = requests[index];
    if (!request) {
      throw new Error(`no request was sent at index ${index}`);
    }
    return request.json();
  });
}

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("resolvePostHogHost", () => {
  // A connection saved without a host is a US Cloud project, which is the one
  // most people have.
  it.each([undefined, "", "   "])("falls back to US Cloud for %o", (host) => {
    expect(resolvePostHogHost(host)).toBe("https://us.i.posthog.com");
  });

  it("takes a trailing slash off so a path cannot double it", () => {
    expect(resolvePostHogHost("https://eu.i.posthog.com/")).toBe(
      "https://eu.i.posthog.com"
    );
  });
});

describe("captureEvent", () => {
  it.effect("posts the event with the project key in the body", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json({ status: 1 }));

      const answer = yield* captureEvent(CONNECTION, EVENT);

      expect(answer).toEqual({ status: 1 });

      const request = requests[0];
      expect(request?.url).toBe("https://us.i.posthog.com/i/v0/e/");
      expect(request?.method).toBe("POST");
      // The key travels in the body, not an authorization header. Sending one
      // would be a secret on a header PostHog does not read.
      expect(request?.headers.get("authorization")).toBeNull();

      expect(yield* readBody(0)).toEqual({
        api_key: "phc_key",
        event: "user_signed_up",
        distinct_id: "user_1",
        uuid: "0192f0c3-0000-7000-8000-000000000001",
        timestamp: "2024-12-25T09:00:00.000Z",
        properties: { plan: "pro" },
      });
    }).pipe(withTransport)
  );

  /**
   * US Cloud answers `{"status": "Ok"}` and the reference describes
   * `{"status": 1}`, so both stand. Neither is something a step reads, and that
   * is the point: capture answers the same 200 for a project key it has never
   * seen, which is why the connection test goes to the flags route instead.
   */
  it.effect("accepts either status the capture endpoint answers", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json({ status: "Ok" }));

      expect(yield* captureEvent(CONNECTION, EVENT)).toEqual({ status: "Ok" });
    }).pipe(withTransport)
  );

  /**
   * The whole reason the uuid and the timestamp are minted in a memoized step
   * above this call: PostHog collapses two events only when
   * `[timestamp, distinct_id, event, uuid]` match, so a retry that changed
   * either would leave a duplicate nothing merges away.
   */
  it.effect("resends byte-identical bytes after a 503", () =>
    Effect.gen(function* () {
      let answered = 0;
      stubFetch(() => {
        answered += 1;
        return answered === 1
          ? new Response("", { status: 503, headers: { "retry-after": "0" } })
          : Response.json({ status: 1 });
      });

      yield* captureEvent(CONNECTION, EVENT);

      expect(requests).toHaveLength(2);
      expect(yield* readBody(1)).toEqual(yield* readBody(0));
    }).pipe(withTransport)
  );

  /**
   * The capture endpoint refuses in plain text rather than JSON. The two bodies
   * here are what it actually answered when probed, and the shared transport
   * reads a body as JSON or not at all, so neither sentence reaches the message.
   * Naming the status is what stands in for them.
   */
  it.effect("says what a 400 from the capture endpoint means", () =>
    Effect.gen(function* () {
      stubFetch(
        () =>
          new Response(
            "failed to hydrate events from request: non-engage request missing event name attribute",
            { status: 400 }
          )
      );

      const error = yield* failure(captureEvent(CONNECTION, EVENT));

      expect(error._tag).toBe("ExternalRejected");
      expect(describePostHogFailure(error)).toBe(
        "PostHog could not read the event (HTTP 400)"
      );
    }).pipe(withTransport)
  );

  it.effect("says what a 401 from the capture endpoint means", () =>
    Effect.gen(function* () {
      stubFetch(
        () =>
          new Response("event submitted without an api_key", { status: 401 })
      );

      const error = yield* failure(captureEvent(CONNECTION, EVENT));

      expect(describePostHogFailure(error)).toBe(
        "PostHog refused the project API key (HTTP 401)"
      );
    }).pipe(withTransport)
  );

  // Something in front of PostHog answering HTML is neither of those, and the
  // wording says so rather than inventing a reason.
  it.effect("falls back to the bare status for anything else", () =>
    Effect.gen(function* () {
      stubFetch(() => new Response("<html>gateway</html>", { status: 502 }));

      const error = yield* failure(captureEvent(CONNECTION, EVENT));

      expect(describePostHogFailure(error)).toBe("HTTP 502");
    }).pipe(withTransport)
  );

  // A 2xx whose body is not the shape PostHog documents says so. Reporting
  // success there would tell the run an event was accepted on the strength of
  // something nobody parsed.
  it.effect("refuses a 2xx that is not JSON at all", () =>
    Effect.gen(function* () {
      stubFetch(() => new Response("ok", { status: 200 }));

      const error = yield* failure(captureEvent(CONNECTION, EVENT));

      expect(error._tag).toBe("ExternalUnreadable");
      expect(describePostHogFailure(error)).toBe(
        "PostHog answered 200 with an unrecognized body"
      );
    }).pipe(withTransport)
  );

  // `it.live` rather than `it.effect`: an unreachable attempt is retried on the
  // exponential backoff rather than on a `Retry-After`, and the test clock
  // `it.effect` installs never advances that sleep on its own.
  it.live("recovers when the first attempt never arrives", () =>
    Effect.gen(function* () {
      let answered = 0;
      stubFetch(() => {
        answered += 1;
        return answered === 1
          ? Promise.reject(new Error("ECONNRESET"))
          : Response.json({ status: 1 });
      });

      expect(yield* captureEvent(CONNECTION, EVENT)).toEqual({ status: 1 });
      expect(requests).toHaveLength(2);
    }).pipe(withTransport)
  );

  // The unreachable branch of the message, without spending the backoff a
  // never-answering PostHog would make the case wait out.
  it("says what an unreachable PostHog means", () => {
    expect(
      describePostHogFailure(new ExternalUnreachable({ message: "ECONNRESET" }))
    ).toBe("ECONNRESET");
  });
});

describe("evaluateFlags", () => {
  it.effect("asks about one person on the versioned flags route", () =>
    Effect.gen(function* () {
      stubFetch(() =>
        Response.json({ featureFlags: {}, errorsWhileComputingFlags: false })
      );

      yield* evaluateFlags(CONNECTION, "wfgraph-connection-test");

      expect(requests[0]?.url).toBe("https://us.i.posthog.com/flags?v=2");
      expect(requests[0]?.method).toBe("POST");
      expect(yield* readBody(0)).toEqual({
        api_key: "phc_key",
        distinct_id: "wfgraph-connection-test",
      });
    }).pipe(withTransport)
  );

  // A project with no flags answers a body with neither key in it, which is a
  // valid answer rather than an unreadable one.
  it.effect("accepts a response carrying no flags", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json({}));

      expect(yield* evaluateFlags(CONNECTION, "someone")).toEqual({});
    }).pipe(withTransport)
  );

  /**
   * This is the one refusal PostHog states in JSON, which is what makes the
   * flags route the connection test rather than capture: `attr` arrives null,
   * and `detail` is a sentence worth showing whoever pressed the button.
   */
  it.effect("reads the refusal a bad project key earns", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json(INVALID_KEY_BODY, { status: 401 }));

      const error = yield* failure(evaluateFlags(CONNECTION, "someone"));

      expect(error._tag === "ExternalRejected" ? error.status : undefined).toBe(
        401
      );
      expect(describePostHogFailure(error)).toBe(INVALID_KEY_BODY.detail);
      expect(
        error._tag === "ExternalRejected" && readPostHogError(error.payload)
      ).toEqual(INVALID_KEY_BODY);
    }).pipe(withTransport)
  );
});
