import { ExternalTransport } from "@wfgraph/core/plugin";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, beforeEach } from "vitest";
import {
  describeResendFailure,
  listResendDomains,
  readResendError,
  sendResendEmail,
} from "#src/resend/client";

/**
 * What goes on the wire, now that this plugin builds the request itself instead
 * of handing arguments to the `resend` SDK. These assertions are the record of
 * what Resend's send-email reference says the call looks like.
 *
 * The payload's field names are the step's business, not this module's, so the
 * snake_case mapping is asserted in send-email.test.ts where it happens.
 */

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

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("sendResendEmail", () => {
  it.effect("posts the payload with a bearer token", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json({ id: "email_123" }));

      const sent = yield* sendResendEmail("re_key", {
        from: "a@example.com",
        to: "b@example.com",
        subject: "Hi",
        text: "Body",
      });

      expect(sent).toEqual({ id: "email_123" });

      const request = requests[0];
      expect(request?.url).toBe("https://api.resend.com/emails");
      expect(request?.method).toBe("POST");
      expect(request?.headers.get("authorization")).toBe("Bearer re_key");
      expect(request?.headers.get("content-type")).toBe("application/json");
      expect(request?.headers.get("idempotency-key")).toBeNull();
    }).pipe(withTransport)
  );

  // A retried step must not send a second email. Resend replays the original
  // response for a repeated key, which is what this header buys.
  it.effect("carries the idempotency key when one is given", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json({ id: "email_123" }));

      yield* sendResendEmail("re_key", { subject: "Hi" }, "exec_42");

      expect(requests[0]?.headers.get("idempotency-key")).toBe("exec_42");
    }).pipe(withTransport)
  );

  it.effect("reads Resend's error body back", () =>
    Effect.gen(function* () {
      stubFetch(() =>
        Response.json(
          {
            statusCode: 422,
            name: "validation_error",
            message: "The `to` field is required.",
          },
          { status: 422 }
        )
      );

      const error = yield* failure(
        sendResendEmail("re_key", { subject: "Hi" })
      );

      expect(error._tag).toBe("ExternalRejected");
      expect(error._tag === "ExternalRejected" ? error.status : undefined).toBe(
        422
      );
      expect(describeResendFailure(error)).toBe("The `to` field is required.");
      expect(
        error._tag === "ExternalRejected" && readResendError(error.payload)
      ).toEqual({
        statusCode: 422,
        name: "validation_error",
        message: "The `to` field is required.",
      });
    }).pipe(withTransport)
  );

  // Reporting success without an id would tell the run an email went out and
  // leave nothing to look it up by.
  it.effect("refuses a 2xx that carries no email id", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json({ queued: true }));

      const error = yield* failure(
        sendResendEmail("re_key", { subject: "Hi" })
      );

      expect(error._tag).toBe("ExternalUnreadable");
      expect(
        error._tag === "ExternalUnreadable" ? error.status : undefined
      ).toBe(200);
      expect(describeResendFailure(error)).toBe(
        "Resend answered 200 with an unrecognized body"
      );
    }).pipe(withTransport)
  );

  it.effect("reports an unreachable Resend with no status at all", () =>
    Effect.gen(function* () {
      stubFetch(() => Promise.reject(new Error("ECONNRESET")));

      const error = yield* failure(
        sendResendEmail("re_key", { subject: "Hi" })
      );

      expect(error._tag).toBe("ExternalUnreachable");
      expect(describeResendFailure(error)).toBe("ECONNRESET");
    }).pipe(withTransport)
  );
});

describe("listResendDomains", () => {
  it.effect("reads domains back without a body", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json({ data: [] }));

      yield* listResendDomains("re_key");

      const request = requests[0];
      expect(request?.url).toBe("https://api.resend.com/domains");
      expect(request?.method).toBe("GET");
      expect(request?.headers.get("content-type")).toBeNull();
    }).pipe(withTransport)
  );
});
