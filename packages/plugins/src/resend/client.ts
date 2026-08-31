/**
 * Resend's email API over fetch.
 *
 * The `resend` SDK is a thin runtime wrapper over the endpoints this plugin
 * needs, so the calls are written out here. Its public raw-request and success
 * types still pin these wire contracts at compile time. Everything after the
 * request is described in `external-http.ts`; this module owns the bearer token,
 * endpoint paths, wire schemas, and how Resend's error body reads.
 *
 * The request body uses Resend's snake_case wire names (`reply_to`,
 * `scheduled_at`, `topic_id`). Getting that backwards drops those fields
 * silently, so the mapping is also asserted in resend/send-email.test.ts.
 */

import type { JsonObject, JsonValue } from "@wfgraph/core/plugin";
import type { DeepReadonly } from "es-toolkit/types";
import { Effect, Schema } from "effect";
import type { HttpClient } from "effect/unstable/http";
import type {
  CreateEmailResponseSuccess,
  EmailApiOptions,
  GetEmailResponseSuccess,
  GetTemplateResponseSuccess,
  ListTemplatesResponseSuccess,
} from "resend";
import {
  callExternal,
  parsePayload,
  type ExternalError,
} from "@wfgraph/core/plugin";

const RESEND_API_BASE = "https://api.resend.com";

type ResendEmailBaseOption =
  | "bcc"
  | "cc"
  | "from"
  | "reply_to"
  | "scheduled_at"
  | "subject"
  | "tags"
  | "to"
  | "topic_id";

type ResendEmailBase = Omit<
  Pick<EmailApiOptions, ResendEmailBaseOption>,
  "from" | "subject" | "to"
> &
  Required<Pick<EmailApiOptions, "from" | "subject" | "to">>;

export type ResendEmailContent =
  | {
      html: NonNullable<EmailApiOptions["html"]>;
      text?: EmailApiOptions["text"];
    }
  | {
      html?: EmailApiOptions["html"];
      text: NonNullable<EmailApiOptions["text"]>;
    }
  | {
      template: NonNullable<EmailApiOptions["template"]>;
    };

export type ResendEmailPayload = ResendEmailBase & ResendEmailContent;

type SameWireShape<Actual, Expected> = [Actual] extends [DeepReadonly<Expected>]
  ? [DeepReadonly<Expected>] extends [Actual]
    ? unknown
    : never
  : never;

/**
 * Keep a runtime codec's encoded side equal to a projection of Resend's types.
 *
 * Returning the codec unchanged preserves its inferred decoded side, including
 * conversions such as an API timestamp string becoming a Date.
 */
function resendResponseSchema<Wire>() {
  return <S extends Schema.Codec<unknown, unknown>>(
    schema: S & SameWireShape<S["Encoded"], Wire>
  ): S => schema;
}

/** Resend's error body. `name` is the machine-readable slug. */
const resendErrorSchema = Schema.Struct({
  statusCode: Schema.optionalKey(Schema.Finite),
  name: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
});

type SentEmailWire = Pick<CreateEmailResponseSuccess, "id">;

const sentEmailSchema = resendResponseSchema<SentEmailWire>()(
  Schema.Struct({ id: Schema.String })
);

/** The fields the Find Email action reads from Resend's retrieve response. */
type ResendEmailWire = Pick<
  GetEmailResponseSuccess,
  | "bcc"
  | "cc"
  | "created_at"
  | "from"
  | "html"
  | "id"
  | "last_event"
  | "message_id"
  | "reply_to"
  | "scheduled_at"
  | "subject"
  | "tags"
  | "text"
  | "to"
>;

const resendEmailSchema = resendResponseSchema<ResendEmailWire>()(
  Schema.Struct({
    id: Schema.String,
    message_id: Schema.String,
    from: Schema.String,
    to: Schema.Array(Schema.String),
    cc: Schema.NullOr(Schema.Array(Schema.String)),
    bcc: Schema.NullOr(Schema.Array(Schema.String)),
    reply_to: Schema.NullOr(Schema.Array(Schema.String)),
    subject: Schema.String,
    html: Schema.NullOr(Schema.String),
    text: Schema.NullOr(Schema.String),
    created_at: Schema.DateFromString,
    last_event: Schema.Literals([
      "bounced",
      "canceled",
      "clicked",
      "complained",
      "delivered",
      "delivery_delayed",
      "failed",
      "opened",
      "queued",
      "scheduled",
      "sent",
      "suppressed",
    ]),
    scheduled_at: Schema.NullOr(Schema.DateFromString),
    tags: Schema.optionalKey(
      Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String }))
    ),
  })
);

type ResendEmail = typeof resendEmailSchema.Type;

/**
 * Resend's error body, for a caller that reports more than the message.
 *
 * The connection test is that caller: a send-only key answers
 * `restricted_api_key` on the domains endpoint, which confirms the key works,
 * and only the slug says so.
 */
export function readResendError(payload: JsonValue | undefined) {
  return parsePayload(payload, resendErrorSchema);
}

/**
 * Why Resend refused, in the vocabulary its two callers both act on.
 *
 * The slug alone is not enough: Resend answers `restricted_api_key` at 401 for a
 * send-only key, which is a working credential, and at 403 for a key that is no
 * longer active, which is not. Keying on both is what keeps a suspended key from
 * being reported as one that only needs a wider grant.
 */
export type ResendRefusal =
  /** A working key Resend restricts to sending, which only a manual key is. */
  | "send_only_key"
  /** A working token whose grant does not cover the route, which only OAuth is. */
  | "insufficient_scope"
  /** The credential itself will not work: inactive, suspended, over quota. */
  | "key_unusable"
  | "unreachable"
  | "refused";

export function classifyResendFailure(error: ExternalError): ResendRefusal {
  if (error._tag === "ExternalUnreachable") {
    return "unreachable";
  }

  const body =
    error._tag === "ExternalRejected"
      ? readResendError(error.payload)
      : undefined;
  // Resend quotes a status in its own error body, which is the number its
  // documentation attaches to the slug. That one wins when it is there.
  const status = body?.statusCode ?? error.status;

  if (body?.name === "invalid_permission" && status === 403) {
    return "insufficient_scope";
  }
  if (body?.name === "restricted_api_key") {
    // Resend spells this slug twice: 401 for a key restricted to sending, which
    // works, and 403 for a key that is no longer active, which does not.
    return status === 403 ? "key_unusable" : "send_only_key";
  }
  if (
    body?.name === "suspended_api_key" ||
    body?.name === "email_above_quota"
  ) {
    return "key_unusable";
  }

  return "refused";
}

/**
 * What Resend said, in one sentence a person reads.
 *
 * A refusal carries Resend's own message when its error body is the documented
 * shape and the bare status when it is not. A 2xx whose body is not the
 * documented resource says so, because reporting success there would tell the
 * run an email went out and leave nothing to look it up by.
 */
export function describeResendFailure(error: ExternalError): string {
  if (error._tag === "ExternalUnreachable") {
    return error.message;
  }

  if (error._tag === "ExternalUnreadable") {
    return `Resend answered ${error.status} with an unrecognized body`;
  }

  return readResendError(error.payload)?.message ?? `HTTP ${error.status}`;
}

function requestResend<S extends Schema.ConstraintDecoder<unknown>>(
  apiKey: string,
  path: string,
  schema: S,
  init: {
    method: "GET" | "POST";
    jsonBody?: JsonObject;
    /**
     * Resend replays the original response for a repeated key rather than
     * sending a second email, which is what makes a retried step safe.
     */
    idempotencyKey?: string;
  }
): Effect.Effect<S["Type"], ExternalError, HttpClient.HttpClient> {
  return callExternal({
    system: "Resend",
    url: `${RESEND_API_BASE}${path}`,
    method: init.method,
    headers: { authorization: `Bearer ${apiKey}` },
    body:
      init.jsonBody === undefined
        ? undefined
        : { kind: "json", value: init.jsonBody },
    idempotencyKey: init.idempotencyKey,
    schema,
  });
}

/**
 * Resend's template shapes, described as the wire sends them rather than as the
 * SDK types them. Only what a caller reads is required; the rest is tolerant,
 * because a field this plugin ignores must not fail the decode.
 */
type ResendTemplateListItem = ListTemplatesResponseSuccess["data"][number];

type ResendTemplateSummaryWire = Pick<ResendTemplateListItem, "id" | "name"> & {
  status?: ResendTemplateListItem["status"] | null;
};

const resendTemplateSummarySchema =
  resendResponseSchema<ResendTemplateSummaryWire>()(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      status: Schema.optionalKey(
        Schema.NullOr(Schema.Literals(["draft", "published"]))
      ),
    })
  );

type ResendTemplateListWire = {
  data: ResendTemplateSummaryWire[];
  has_more?: ListTemplatesResponseSuccess["has_more"] | null;
};

const resendTemplateListSchema = resendResponseSchema<ResendTemplateListWire>()(
  Schema.Struct({
    data: Schema.Array(resendTemplateSummarySchema),
    has_more: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  })
);

type SdkTemplateVariable = NonNullable<
  GetTemplateResponseSuccess["variables"]
>[number];

type ResendTemplateVariableWire = Pick<SdkTemplateVariable, "key"> & {
  type?: SdkTemplateVariable["type"] | null;
  fallback_value?: SdkTemplateVariable["fallback_value"];
};

const resendTemplateVariableSchema =
  resendResponseSchema<ResendTemplateVariableWire>()(
    Schema.Struct({
      key: Schema.String,
      type: Schema.optionalKey(
        Schema.NullOr(Schema.Literals(["string", "number"]))
      ),
      fallback_value: Schema.optionalKey(
        Schema.NullOr(Schema.Union([Schema.String, Schema.Finite]))
      ),
    })
  );

/** Only the retrieve endpoint carries `variables`; the list endpoint does not. */
type ResendTemplateWire = Pick<GetTemplateResponseSuccess, "id" | "name"> & {
  status?: GetTemplateResponseSuccess["status"] | null;
  variables?: ResendTemplateVariableWire[] | null;
};

const resendTemplateSchema = resendResponseSchema<ResendTemplateWire>()(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    status: Schema.optionalKey(
      Schema.NullOr(Schema.Literals(["draft", "published"]))
    ),
    variables: Schema.optionalKey(
      Schema.NullOr(Schema.Array(resendTemplateVariableSchema))
    ),
  })
);

export type ResendTemplateSummary = typeof resendTemplateSummarySchema.Type;
type ResendTemplate = typeof resendTemplateSchema.Type;

/** Resend's own maximum, so a page never asks for more than it will answer. */
const TEMPLATE_PAGE_SIZE = 100;

/**
 * How many pages a listing follows before it gives up.
 *
 * Each page carries `callExternal`'s own per-attempt timeout and retry schedule,
 * so a page is worth tens of seconds in the worst case and this is the number a
 * config panel can wait on. Reaching the bound is reported rather than passed
 * off as the whole list: a dropdown quietly missing the template someone wants,
 * with no way to type it either, is worse than saying the list is too long.
 */
const TEMPLATE_PAGE_LIMIT = 3;

/**
 * A listing, and whether it is all of them.
 *
 * Reaching the bound is a fact this reports rather than a failure it raises: a
 * caller drawing a picker treats it as one, and a caller doing something else
 * need not.
 */
export type ResendTemplateListing = {
  readonly templates: readonly ResendTemplateSummary[];
  readonly reachedPageLimit: boolean;
};

function listResendTemplatePage(
  apiKey: string,
  after?: string
): Effect.Effect<
  typeof resendTemplateListSchema.Type,
  ExternalError,
  HttpClient.HttpClient
> {
  const query = new URLSearchParams({ limit: String(TEMPLATE_PAGE_SIZE) });
  if (after) {
    query.set("after", after);
  }

  return requestResend(
    apiKey,
    `/templates?${query.toString()}`,
    resendTemplateListSchema,
    { method: "GET" }
  );
}

/**
 * Every template the account holds, or a refusal when there are more than the
 * bound above will fetch.
 */
export function listResendTemplates(
  apiKey: string
): Effect.Effect<ResendTemplateListing, ExternalError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const templates: ResendTemplateSummary[] = [];
    let after: string | undefined;

    for (let page = 0; page < TEMPLATE_PAGE_LIMIT; page += 1) {
      const answer = yield* listResendTemplatePage(apiKey, after);
      templates.push(...answer.data);

      // A page claiming more while sending none has no cursor to follow, so it
      // ends the listing rather than repeating the same request forever.
      const last = answer.data.at(-1);
      if (!answer.has_more || !last) {
        return { templates, reachedPageLimit: false };
      }
      after = last.id;
    }

    return { templates, reachedPageLimit: true };
  });
}

/** One template, with the variables only this endpoint carries. */
export function getResendTemplate(
  apiKey: string,
  idOrAlias: string
): Effect.Effect<ResendTemplate, ExternalError, HttpClient.HttpClient> {
  return requestResend(
    apiKey,
    `/templates/${encodeURIComponent(idOrAlias)}`,
    resendTemplateSchema,
    { method: "GET" }
  );
}

export function sendResendEmail(
  apiKey: string,
  payload: ResendEmailPayload,
  idempotencyKey?: string
): Effect.Effect<{ id: string }, ExternalError, HttpClient.HttpClient> {
  return requestResend(apiKey, "/emails", sentEmailSchema, {
    method: "POST",
    jsonBody: payload,
    idempotencyKey,
  });
}

/** Retrieve one sent email by its Resend email ID. */
export function getResendEmail(
  apiKey: string,
  emailId: string
): Effect.Effect<ResendEmail, ExternalError, HttpClient.HttpClient> {
  return requestResend(
    apiKey,
    `/emails/${encodeURIComponent(emailId)}`,
    resendEmailSchema,
    { method: "GET" }
  );
}

/**
 * Listing domains is a read-only call any valid key can make, which makes it the
 * check that says whether a key works without sending anything.
 */
export function listResendDomains(
  apiKey: string
): Effect.Effect<unknown, ExternalError, HttpClient.HttpClient> {
  return requestResend(apiKey, "/domains", Schema.Unknown, { method: "GET" });
}
