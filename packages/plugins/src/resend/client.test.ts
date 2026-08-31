import { ExternalTransport } from "@wfgraph/core/plugin";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, beforeEach } from "vitest";
import {
  describeResendFailure,
  getResendEmail,
  getResendTemplate,
  listResendDomains,
  listResendTemplates,
  readResendError,
  type ResendEmailPayload,
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

const validEmailPayload = {
  from: "a@example.com",
  to: "b@example.com",
  subject: "Hi",
  text: "Body",
} satisfies ResendEmailPayload;

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

      const sent = yield* sendResendEmail("re_key", validEmailPayload);

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

      yield* sendResendEmail("re_key", validEmailPayload, "exec_42");

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
        sendResendEmail("re_key", validEmailPayload)
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
        sendResendEmail("re_key", validEmailPayload)
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
        sendResendEmail("re_key", validEmailPayload)
      );

      expect(error._tag).toBe("ExternalUnreachable");
      expect(describeResendFailure(error)).toBe("ECONNRESET");
    }).pipe(withTransport)
  );
});

describe("getResendEmail", () => {
  it.effect("retrieves one email with a bearer token and an encoded id", () =>
    Effect.gen(function* () {
      stubFetch(() =>
        Response.json({
          object: "email",
          id: "email_123",
          message_id: "<message@example.com>",
          to: ["delivered@example.com"],
          from: "Support <support@example.com>",
          created_at: "2026-04-03 22:13:42.674981+00",
          subject: "Hello World",
          html: "<strong>Hello</strong>",
          text: null,
          bcc: [],
          cc: ["manager@example.com"],
          reply_to: ["reply@example.com"],
          last_event: "delivered",
          scheduled_at: null,
          tags: [{ name: "order_id", value: "ord_7" }],
        })
      );

      const email = yield* getResendEmail("re_key", "email a/b");

      expect(email.id).toBe("email_123");
      expect(email.text).toBeNull();
      expect(email.created_at).toEqual(new Date("2026-04-03T22:13:42.674981Z"));
      expect(email.tags).toEqual([{ name: "order_id", value: "ord_7" }]);
      expect(requests[0]?.url).toBe(
        "https://api.resend.com/emails/email%20a%2Fb"
      );
      expect(requests[0]?.method).toBe("GET");
      expect(requests[0]?.headers.get("authorization")).toBe("Bearer re_key");
      expect(requests[0]?.headers.get("content-type")).toBeNull();
    }).pipe(withTransport)
  );

  it.effect("accepts null recipient lists and an omitted tags field", () =>
    Effect.gen(function* () {
      stubFetch(() =>
        Response.json({
          id: "email_123",
          message_id: "<message@example.com>",
          to: ["delivered@example.com"],
          from: "Support <support@example.com>",
          created_at: "2026-04-03 22:13:42.674981+00",
          subject: "Hello World",
          html: null,
          text: "Hello",
          bcc: null,
          cc: null,
          reply_to: null,
          last_event: "delivered",
          scheduled_at: null,
        })
      );

      const email = yield* getResendEmail("re_key", "email_123");

      expect(email.cc).toBeNull();
      expect(email.bcc).toBeNull();
      expect(email.reply_to).toBeNull();
      expect(email.tags).toBeUndefined();
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

/**
 * The template endpoints, as Resend's reference describes them: the list carries
 * no variables and the retrieve does, which is why a picker needs both.
 */
describe("the Resend template endpoints", () => {
  it.effect(
    "asks for a full page and follows the cursor while more remain",
    () =>
      Effect.gen(function* () {
        const pages = [
          {
            data: [
              { id: "tpl_1", name: "Welcome", status: "published" },
              { id: "tpl_2", name: "Draft one", status: "draft" },
            ],
            has_more: true,
          },
          {
            data: [{ id: "tpl_3", name: "Reminder", status: "published" }],
            has_more: false,
          },
        ];
        let page = 0;
        stubFetch(() => Response.json(pages[page++]));

        const listing =
          yield* listResendTemplates("re_key").pipe(withTransport);

        expect(listing.templates.map((template) => template.id)).toEqual([
          "tpl_1",
          "tpl_2",
          "tpl_3",
        ]);
        expect(listing.reachedPageLimit).toBe(false);
        expect(requests[0]?.url).toBe(
          "https://api.resend.com/templates?limit=100"
        );
        // The cursor is the last id of the page just read.
        expect(requests[1]?.url).toBe(
          "https://api.resend.com/templates?limit=100&after=tpl_2"
        );
        expect(requests[0]?.headers.get("authorization")).toBe("Bearer re_key");
      })
  );

  it.effect("stops following once a page says there is no more", () =>
    Effect.gen(function* () {
      stubFetch(() =>
        Response.json({
          data: [{ id: "tpl_1", name: "Welcome", status: "published" }],
          has_more: false,
        })
      );

      yield* listResendTemplates("re_key").pipe(withTransport);

      expect(requests).toHaveLength(1);
    })
  );

  it.effect(
    "reads one template's variables, encoding its id into the path",
    () =>
      Effect.gen(function* () {
        stubFetch(() =>
          Response.json({
            id: "tpl_1",
            name: "Welcome",
            status: "published",
            variables: [
              { key: "FIRST_NAME", type: "string" },
              { key: "CITY", type: "string", fallback_value: "Burbank" },
              { key: "RETRIES", type: "number", fallback_value: null },
            ],
          })
        );

        const template = yield* getResendTemplate("re_key", "a b/c").pipe(
          withTransport
        );

        expect(requests[0]?.url).toBe(
          "https://api.resend.com/templates/a%20b%2Fc"
        );
        expect(template.variables?.map((variable) => variable.key)).toEqual([
          "FIRST_NAME",
          "CITY",
          "RETRIES",
        ]);
        // A null fallback is a value Resend really sends, and it is not a default.
        expect(template.variables?.[2]?.fallback_value).toBeNull();
      })
  );

  it.effect("stops on a page that claims more while sending none", () =>
    Effect.gen(function* () {
      // No cursor to follow, so following it would repeat the same request.
      stubFetch(() => Response.json({ data: [], has_more: true }));

      const listing = yield* listResendTemplates("re_key").pipe(withTransport);

      expect(listing.templates).toEqual([]);
      expect(requests).toHaveLength(1);
    })
  );

  it.effect("says so rather than truncating when it runs out of pages", () =>
    Effect.gen(function* () {
      let page = 0;
      stubFetch(() =>
        Response.json({
          data: [{ id: `tpl_${page++}`, name: "One", status: "published" }],
          has_more: true,
        })
      );

      const listing = yield* listResendTemplates("re_key").pipe(withTransport);

      // The bound is what keeps a config panel from waiting on an unbounded
      // vendor loop, and the flag is what stops the caller passing a partial
      // list off as the whole one.
      expect(requests).toHaveLength(3);
      expect(listing.reachedPageLimit).toBe(true);
    })
  );

  it.effect(
    "decodes the list response as Resend records it, extra fields and all",
    () =>
      Effect.gen(function* () {
        stubFetch(() =>
          Response.json({
            object: "list",
            data: [
              {
                id: "e169aa45-1ecf-4183-9955-b1499d5701d3",
                object: "template",
                name: "reset-password",
                alias: "reset-password",
                status: "draft",
                published_at: null,
                created_at: "2026-10-06 23:47:56.678+00",
                updated_at: "2026-10-06 23:47:56.678+00",
              },
            ],
            has_more: false,
          })
        );

        const listing =
          yield* listResendTemplates("re_key").pipe(withTransport);

        // The schema is deliberately tolerant of everything this plugin ignores,
        // and a recorded body is the only thing that proves it.
        expect(listing.templates[0]?.name).toBe("reset-password");
      })
  );

  it.effect("decodes the retrieve response as Resend records it", () =>
    Effect.gen(function* () {
      stubFetch(() =>
        Response.json({
          object: "template",
          id: "34a080c9-0e07-4c1e-9b0f-2a2a5ec2c2f7",
          current_version_id: "b269e8a4-5d1e-4a53-9d0b-6a3b0c1a2d3e",
          alias: "reset-password",
          name: "reset-password",
          status: "published",
          published_at: "2026-10-06 23:50:00.000+00",
          created_at: "2026-10-06 23:47:56.678+00",
          updated_at: "2026-10-06 23:47:56.678+00",
          from: "Support <support@example.com>",
          subject: "Reset your password",
          reply_to: null,
          html: "<h1>Hi</h1>",
          text: "Hi",
          has_unpublished_versions: true,
          variables: [
            {
              id: "e169aa45-1ecf-4183-9955-b1499d5701d3",
              key: "user_name",
              type: "string",
              fallback_value: "John Doe",
              created_at: "2026-10-06 23:47:56.678+00",
              updated_at: "2026-10-06 23:47:56.678+00",
            },
          ],
        })
      );

      const template = yield* getResendTemplate(
        "re_key",
        "reset-password"
      ).pipe(withTransport);

      expect(template.variables?.[0]?.fallback_value).toBe("John Doe");
    })
  );

  it.effect("refuses a template list that is not the documented shape", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json({ templates: [] }));

      const error = yield* listResendTemplates("re_key").pipe(
        withTransport,
        failure
      );

      expect(error._tag).toBe("ExternalUnreadable");
    })
  );
});
