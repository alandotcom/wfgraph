/**
 * Both PostHog handlers, driven through the whole action boundary.
 *
 * What these steps decide is whether to capture at all, what the property bags
 * come out as, and what identity the event is sent under. What the client puts
 * on the wire is covered separately in posthog/client.test.ts, against a stubbed
 * fetch.
 */

import { describe, expect, it } from "@effect/vitest";
import { actionData, actionError, runAction } from "@wfgraph/core/testing";
import { Effect } from "effect";
import { afterEach, beforeEach, vi } from "vitest";
import * as posthogClient from "#src/posthog/client";
import { posthog } from "#src/posthog/index";

// Spy rather than `vi.mock` so a worker that already evaluated this module
// still sees the stub.
const mocks = vi.hoisted(() => ({ captureEvent: vi.fn() }));

const POSTHOG_CREDENTIALS = {
  POSTHOG_PROJECT_API_KEY: "phc_test_key",
  POSTHOG_HOST: "https://eu.i.posthog.com",
};

/** A key-value config field, as the editor's widget writes it. */
function keyValue(entries: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(entries).map(([name, value]) => ({ name, value }))
  );
}

/**
 * The credentials a run would have fetched, and a count of the times the step
 * asked for them.
 *
 * A step hands its handler the fetch as an effect rather than a value, so a step
 * that decides it has nothing to capture never reads the integration's secrets.
 * The count is what pins that.
 */
function credentialsRead(
  values: Record<string, string | undefined> = POSTHOG_CREDENTIALS
) {
  const reads = { count: 0 };

  return {
    reads,
    credentials: Effect.sync(() => {
      reads.count += 1;
      return values;
    }),
  };
}

/** The event body the step handed the client on its one call. */
function capturedEvent() {
  return mocks.captureEvent.mock.calls[0]?.[1];
}

/** The connection the step built out of the credentials. */
function capturedConnection() {
  return mocks.captureEvent.mock.calls[0]?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.captureEvent.mockReturnValue(Effect.succeed({ status: 1 }));
  vi.spyOn(posthogClient, "captureEvent").mockImplementation(
    mocks.captureEvent
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the capture-event action", () => {
  it.effect("logs only in test mode by default and skips external calls", () =>
    Effect.gen(function* () {
      const { reads, credentials } = credentialsRead();

      const result = actionData(
        yield* runAction(posthog, "capture-event", {
          input: { eventName: "user_signed_up", distinctId: "user_1" },
          credentials,
          runMode: "test",
        })
      );

      expect(result).toEqual({
        eventName: "user_signed_up",
        distinctId: "user_1",
        eventUuid: "",
        timestamp: "",
        reasonCode: "test_mode_log_only",
      });
      expect(reads.count).toBe(0);
      expect(mocks.captureEvent).toHaveBeenCalledTimes(0);
    })
  );

  it.effect("captures in test mode when asked to", () =>
    Effect.gen(function* () {
      const { reads, credentials } = credentialsRead();

      yield* runAction(posthog, "capture-event", {
        input: {
          eventName: "user_signed_up",
          distinctId: "user_1",
          testBehavior: "send",
        },
        credentials,
        runMode: "test",
      });

      expect(reads.count).toBe(1);
      expect(mocks.captureEvent).toHaveBeenCalledTimes(1);
    })
  );

  it.effect(
    "does not suppress live mode even if test behavior is log_only",
    () =>
      Effect.gen(function* () {
        const { credentials } = credentialsRead();

        yield* runAction(posthog, "capture-event", {
          input: {
            eventName: "user_signed_up",
            distinctId: "user_1",
            testBehavior: "log_only",
          },
          credentials,
        });

        expect(mocks.captureEvent).toHaveBeenCalledTimes(1);
      })
  );

  /**
   * The uuid and the timestamp are what make a resend collapse rather than
   * duplicate, and they only do that when the send reuses them across attempts.
   * Taking them in a step of their own is what memoizes them; this says the
   * event went out under the identity the step reported, so the two cannot
   * quietly come apart.
   */
  it.effect("sends the event under the identity it reports downstream", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      const result = actionData(
        yield* runAction(posthog, "capture-event", {
          input: { eventName: "user_signed_up", distinctId: "user_1" },
          credentials,
        })
      );

      const event = capturedEvent();

      expect(event.uuid).toBe(result.eventUuid);
      expect(event.timestamp).toBe(result.timestamp);
      // A valid UUID, which is the only kind PostHog reads: it ignores anything
      // else and mints its own, which would take the dedup with it.
      expect(result.eventUuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(result.timestamp).toBe(new Date(result.timestamp).toISOString());
    })
  );

  it.effect("prefers the timestamp the builder authored", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      const result = actionData(
        yield* runAction(posthog, "capture-event", {
          input: {
            eventName: "user_signed_up",
            distinctId: "user_1",
            timestamp: "  2024-12-25T09:00:00Z  ",
          },
          credentials,
        })
      );

      expect(result.timestamp).toBe("2024-12-25T09:00:00Z");
      expect(capturedEvent().timestamp).toBe("2024-12-25T09:00:00Z");
    })
  );

  it.effect("folds the key-value rows into one property bag", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      yield* runAction(posthog, "capture-event", {
        input: {
          eventName: "user_signed_up",
          distinctId: "user_1",
          properties: keyValue({ plan: "pro", source: "referral" }),
        },
        credentials,
      });

      expect(capturedEvent().properties).toEqual({
        plan: "pro",
        source: "referral",
      });
    })
  );

  // A key-value row is always text, so the JSON box is the only way to send a
  // number or a boolean. It goes on last so one key can be overridden without
  // rewriting the rows.
  it.effect("lets the JSON box override a key the rows set", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      yield* runAction(posthog, "capture-event", {
        input: {
          eventName: "user_signed_up",
          distinctId: "user_1",
          properties: keyValue({ plan: "pro", seats: "12" }),
          propertiesJson: '{"seats": 12, "trial": false}',
        },
        credentials,
      });

      expect(capturedEvent().properties).toEqual({
        plan: "pro",
        seats: 12,
        trial: false,
      });
    })
  );

  // Losing a property beats losing the event, so unreadable text is dropped
  // rather than failing the node.
  it.effect(
    "captures without the properties when the JSON does not parse",
    () =>
      Effect.gen(function* () {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const { credentials } = credentialsRead();

        yield* runAction(posthog, "capture-event", {
          input: {
            eventName: "user_signed_up",
            distinctId: "user_1",
            propertiesJson: "{not json",
          },
          credentials,
        });

        expect(mocks.captureEvent).toHaveBeenCalledTimes(1);
        expect(capturedEvent().properties).toBeUndefined();
      })
  );

  // An empty bag is left off the wire rather than sent as `{}`.
  it.effect("sends no properties key when nothing was authored", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      yield* runAction(posthog, "capture-event", {
        input: {
          eventName: "user_signed_up",
          distinctId: "user_1",
          properties: keyValue({}),
        },
        credentials,
      });

      expect("properties" in capturedEvent()).toBe(false);
    })
  );

  it.effect("turns off the person profile for an anonymous event", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      yield* runAction(posthog, "capture-event", {
        input: {
          eventName: "page_viewed",
          distinctId: "visitor_1",
          personProfile: "anonymous",
        },
        credentials,
      });

      expect(capturedEvent().properties).toEqual({
        $process_person_profile: false,
      });
    })
  );

  it.effect("reaches the host the connection named", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      yield* runAction(posthog, "capture-event", {
        input: { eventName: "user_signed_up", distinctId: "user_1" },
        credentials,
      });

      expect(capturedConnection()).toEqual({
        projectApiKey: "phc_test_key",
        host: "https://eu.i.posthog.com",
      });
    })
  );

  it.effect("falls back to US Cloud when the connection named no host", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead({
        POSTHOG_PROJECT_API_KEY: "phc_test_key",
      });

      yield* runAction(posthog, "capture-event", {
        input: { eventName: "user_signed_up", distinctId: "user_1" },
        credentials,
      });

      expect(capturedConnection().host).toBe("https://us.i.posthog.com");
    })
  );

  it.effect("fails with the message the system's refusal carries", () =>
    Effect.gen(function* () {
      mocks.captureEvent.mockReturnValue(
        Effect.fail({ _tag: "ExternalRejected", status: 400, payload: {} })
      );
      const { credentials } = credentialsRead();

      const error = actionError(
        yield* runAction(posthog, "capture-event", {
          input: { eventName: "user_signed_up", distinctId: "user_1" },
          credentials,
        })
      );

      expect(error.message).toBe(
        "Failed to capture event: PostHog could not read the event (HTTP 400)"
      );
    })
  );

  it.effect("says which credential is missing before reaching PostHog", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead({});

      const error = actionError(
        yield* runAction(posthog, "capture-event", {
          input: { eventName: "user_signed_up", distinctId: "user_1" },
          credentials,
        })
      );

      expect(error.message).toBe(
        "POSTHOG_PROJECT_API_KEY is not configured. Please add it in Project Integrations."
      );
      expect(mocks.captureEvent).toHaveBeenCalledTimes(0);
    })
  );

  // Both fields are required in the form, but a template that resolved to
  // nothing still arrives blank. PostHog would take the event and file it
  // against a person nobody can find.
  it.effect("refuses a distinct id that resolved to nothing", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      const error = actionError(
        yield* runAction(posthog, "capture-event", {
          input: { eventName: "user_signed_up", distinctId: "   " },
          credentials,
        })
      );

      expect(error.message).toBe(
        "distinctId resolved to nothing. PostHog needs a distinct id to attach the event to a person."
      );
      expect(mocks.captureEvent).toHaveBeenCalledTimes(0);
    })
  );

  it.effect("refuses an event name that resolved to nothing", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      const error = actionError(
        yield* runAction(posthog, "capture-event", {
          input: { eventName: "", distinctId: "user_1" },
          credentials,
        })
      );

      expect(error.message).toBe(
        "eventName resolved to nothing. PostHog needs an event name."
      );
    })
  );
});

describe("the identify-person action", () => {
  it.effect("logs only in test mode by default and skips external calls", () =>
    Effect.gen(function* () {
      const { reads, credentials } = credentialsRead();

      const result = actionData(
        yield* runAction(posthog, "identify-person", {
          input: {
            distinctId: "user_1",
            setProperties: keyValue({ email: "a@example.com" }),
          },
          credentials,
          runMode: "test",
        })
      );

      expect(result).toEqual({
        distinctId: "user_1",
        eventUuid: "",
        timestamp: "",
        reasonCode: "test_mode_log_only",
      });
      expect(reads.count).toBe(0);
      expect(mocks.captureEvent).toHaveBeenCalledTimes(0);
    })
  );

  it.effect(
    "sends $identify with both property bags under PostHog's names",
    () =>
      Effect.gen(function* () {
        const { credentials } = credentialsRead();

        const result = actionData(
          yield* runAction(posthog, "identify-person", {
            input: {
              distinctId: "user_1",
              setProperties: keyValue({ email: "a@example.com" }),
              setPropertiesJson: '{"seats": 12}',
              setOnceProperties: keyValue({ signup_source: "referral" }),
            },
            credentials,
          })
        );

        expect(capturedEvent()).toEqual({
          event: "$identify",
          distinct_id: "user_1",
          uuid: result.eventUuid,
          timestamp: result.timestamp,
          $set: { email: "a@example.com", seats: 12 },
          $set_once: { signup_source: "referral" },
        });
      })
  );

  it.effect("leaves out the bag the builder did not fill in", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      yield* runAction(posthog, "identify-person", {
        input: {
          distinctId: "user_1",
          setProperties: keyValue({ email: "a@example.com" }),
        },
        credentials,
      });

      expect("$set_once" in capturedEvent()).toBe(false);
    })
  );

  // An identify carrying neither bag would create a bare person profile and say
  // nothing about them, which is never what the builder meant.
  it.effect("refuses an identify that would set nothing", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      const error = actionError(
        yield* runAction(posthog, "identify-person", {
          input: { distinctId: "user_1" },
          credentials,
        })
      );

      expect(error.message).toBe(
        "Identify Person needs at least one property to set. Add a row to Set Properties or Set Once."
      );
      expect(mocks.captureEvent).toHaveBeenCalledTimes(0);
    })
  );

  it.effect("fails with the message the system's refusal carries", () =>
    Effect.gen(function* () {
      mocks.captureEvent.mockReturnValue(
        Effect.fail({ _tag: "ExternalUnreachable", message: "ECONNRESET" })
      );
      const { credentials } = credentialsRead();

      const error = actionError(
        yield* runAction(posthog, "identify-person", {
          input: {
            distinctId: "user_1",
            setProperties: keyValue({ email: "a@example.com" }),
          },
          credentials,
        })
      );

      expect(error.message).toBe("Failed to identify person: ECONNRESET");
    })
  );

  // A parser miss is not an empty bag. Identify would otherwise report that
  // nothing was authored, which is the wrong recovery for text the builder
  // meant to send.
  it.effect("fails identify when the properties JSON does not parse", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      const error = actionError(
        yield* runAction(posthog, "identify-person", {
          input: {
            distinctId: "user_1",
            setPropertiesJson: "{not json",
          },
          credentials,
        })
      );

      expect(error.message).toBe("Properties JSON is not valid JSON.");
      expect(error.message).not.toContain("needs at least one property");
      expect(mocks.captureEvent).toHaveBeenCalledTimes(0);
    })
  );
});
