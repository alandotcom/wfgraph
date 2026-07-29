/**
 * Twilio's 2010-04-01 REST API over fetch.
 *
 * Two calls are made against Twilio in this plugin: creating a message and
 * reading the account back to check credentials. The `twilio` SDK brought axios,
 * dayjs, and jsonwebtoken along for those two, and axios was the dependency that
 * ended up imported at runtime while no package.json named it.
 *
 * The API takes form-encoded parameters, answers JSON, and authenticates with
 * HTTP basic auth where the account SID is the username and the auth token the
 * password. Everything after that request is described in `vendor-http.ts`, so
 * what is left here is the auth header, the two endpoints, and how Twilio's
 * error body reads.
 */

import { omitBy } from "es-toolkit/object";
import { isNil } from "es-toolkit/predicate";
import { Schema } from "effect";
import {
  callVendor,
  parsePayload,
  runVendorCall,
  type VendorError,
} from "#src/vendor-http";

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

/** Twilio's error body, the same shape on every endpoint. */
const twilioErrorSchema = Schema.Struct({
  code: Schema.optionalKey(Schema.Finite),
  message: Schema.optionalKey(Schema.String),
  more_info: Schema.optionalKey(Schema.String),
});

/** The Message resource, as much of it as this plugin reads. */
const twilioMessageSchema = Schema.Struct({
  sid: Schema.String,
  status: Schema.String,
  to: Schema.String,
  // Twilio leaves an unused field out on some responses and sends null on
  // others, so both stand for "not set" here.
  from: Schema.optionalKey(Schema.NullishOr(Schema.String)),
  messaging_service_sid: Schema.optionalKey(Schema.NullishOr(Schema.String)),
});

export type TwilioMessage = typeof twilioMessageSchema.Type;

export type TwilioFailure =
  | { kind: "unreachable"; message: string }
  | {
      kind: "rejected";
      status: number;
      message: string;
      code?: number;
      moreInfo?: string;
    }
  /** A 2xx whose body is not the resource Twilio documents. */
  | { kind: "unreadable"; status: number };

export type TwilioResult<TData> =
  | { ok: true; data: TData }
  | { ok: false; failure: TwilioFailure };

export function describeTwilioFailure(failure: TwilioFailure): string {
  if (failure.kind === "unreadable") {
    return `Twilio answered ${failure.status} with an unrecognized body`;
  }
  return failure.message;
}

export type TwilioCredentialPair = {
  accountSid: string;
  authToken: string;
};

function toBasicAuth(accountSid: string, authToken: string): string {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
}

/**
 * Twilio's three failures in the vocabulary this plugin's steps already read.
 * Stage 6 of ADR-0002 makes a step handler an Effect over `VendorError` and
 * this translation goes away with the `TwilioResult` shape it feeds.
 */
function toTwilioFailure(error: VendorError): TwilioFailure {
  if (error._tag === "VendorUnreachable") {
    return { kind: "unreachable", message: error.message };
  }

  if (error._tag === "VendorUnreadable") {
    return { kind: "unreadable", status: error.status };
  }

  const body = parsePayload(error.payload, twilioErrorSchema);
  return {
    kind: "rejected",
    status: error.status,
    message: body?.message ?? `HTTP ${error.status}`,
    code: body?.code,
    moreInfo: body?.more_info,
  };
}

function requestTwilio<S extends Schema.ConstraintDecoder<unknown>>(
  credentials: TwilioCredentialPair,
  path: string,
  schema: S,
  init: { method: "GET" | "POST"; body?: URLSearchParams }
): Promise<TwilioResult<S["Type"]>> {
  return runVendorCall(
    callVendor({
      vendor: "Twilio",
      url: `${TWILIO_API_BASE}${path}`,
      method: init.method,
      headers: {
        authorization: toBasicAuth(
          credentials.accountSid,
          credentials.authToken
        ),
      },
      body:
        init.body === undefined
          ? undefined
          : { kind: "form", value: init.body },
      schema,
    }),
    toTwilioFailure
  );
}

/**
 * Twilio's own parameter names, so a caller reads like its documentation.
 * MediaUrl is a list, which the form encoding carries by repeating the key.
 */
export type TwilioMessageParameters = {
  To: string;
  Body: string;
  From?: string;
  MessagingServiceSid?: string;
  StatusCallback?: string;
  MediaUrl?: string[];
};

/**
 * Sending is the one call here that a repeat could do twice, and Twilio's
 * Message resource takes no idempotency key, so it is not retried: a send that
 * timed out on the way back stays sent once.
 */
export function createTwilioMessage(
  credentials: TwilioCredentialPair,
  parameters: TwilioMessageParameters
): Promise<TwilioResult<TwilioMessage>> {
  const { MediaUrl, ...scalars } = parameters;
  const body = new URLSearchParams(omitBy(scalars, isNil));
  for (const mediaUrl of MediaUrl ?? []) {
    body.append("MediaUrl", mediaUrl);
  }

  return requestTwilio(
    credentials,
    `/Accounts/${encodeURIComponent(credentials.accountSid)}/Messages.json`,
    twilioMessageSchema,
    { method: "POST", body }
  );
}

/** Reading the account back is Twilio's cheapest credential check. */
export function fetchTwilioAccount(
  credentials: TwilioCredentialPair
): Promise<TwilioResult<{ sid: string }>> {
  return requestTwilio(
    credentials,
    `/Accounts/${encodeURIComponent(credentials.accountSid)}.json`,
    Schema.Struct({ sid: Schema.String }),
    { method: "GET" }
  );
}
