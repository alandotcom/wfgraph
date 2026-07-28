import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listResendDomains, sendResendEmail } from "#src/resend/client";

/**
 * What goes on the wire, now that this plugin builds the request itself instead
 * of handing arguments to the `resend` SDK. These assertions are the record of
 * what Resend's send-email reference says the call looks like.
 *
 * The payload's field names are the step's business, not this module's, so the
 * snake_case mapping is asserted in steps/send-email.test.ts where it happens.
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

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("sendResendEmail", () => {
  it("posts the payload with a bearer token", async () => {
    stubFetch(() => Response.json({ id: "email_123" }));

    const result = await sendResendEmail("re_key", {
      from: "a@example.com",
      to: "b@example.com",
      subject: "Hi",
      text: "Body",
    });

    expect(result).toEqual({ ok: true, data: { id: "email_123" } });

    const request = requests[0];
    expect(request?.url).toBe("https://api.resend.com/emails");
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("authorization")).toBe("Bearer re_key");
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(request?.headers.get("idempotency-key")).toBeNull();
  });

  // A retried step must not send a second email. Resend replays the original
  // response for a repeated key, which is what this header buys.
  it("carries the idempotency key when one is given", async () => {
    stubFetch(() => Response.json({ id: "email_123" }));

    await sendResendEmail("re_key", { subject: "Hi" }, "exec_42");

    expect(requests[0]?.headers.get("idempotency-key")).toBe("exec_42");
  });

  it("reads Resend's error body back", async () => {
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

    expect(await sendResendEmail("re_key", { subject: "Hi" })).toEqual({
      ok: false,
      failure: {
        kind: "rejected",
        status: 422,
        name: "validation_error",
        message: "The `to` field is required.",
      },
    });
  });

  // Reporting success without an id would tell the run an email went out and
  // leave nothing to look it up by.
  it("refuses a 2xx that carries no email id", async () => {
    stubFetch(() => Response.json({ queued: true }));

    expect(await sendResendEmail("re_key", { subject: "Hi" })).toEqual({
      ok: false,
      failure: { kind: "unreadable", status: 200 },
    });
  });

  it("reports an unreachable Resend with no status at all", async () => {
    stubFetch(() => Promise.reject(new Error("ECONNRESET")));

    expect(await sendResendEmail("re_key", { subject: "Hi" })).toEqual({
      ok: false,
      failure: { kind: "unreachable", message: "ECONNRESET" },
    });
  });
});

describe("listResendDomains", () => {
  it("reads domains back without a body", async () => {
    stubFetch(() => Response.json({ data: [] }));

    await listResendDomains("re_key");

    const request = requests[0];
    expect(request?.url).toBe("https://api.resend.com/domains");
    expect(request?.method).toBe("GET");
    expect(request?.headers.get("content-type")).toBeNull();
  });
});
