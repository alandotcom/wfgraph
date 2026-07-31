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
 * password. Everything after that request is described in `external-http.ts`, so
 * what is left here is the auth header, the two endpoints, and how Twilio's
 * error body reads.
 */

import type { JsonValue } from "@rova/core/plugin";
import type { Effect } from "effect";
import { omitBy } from "es-toolkit/object";
import { isNil } from "es-toolkit/predicate";
import { Schema } from "effect";
import type { HttpClient } from "effect/unstable/http";
import {
  callExternal,
  parsePayload,
  type ExternalError,
} from "@rova/core/plugin";

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

/**
 * What Twilio said, in one sentence a person reads.
 *
 * A refusal carries Twilio's own message when its error body is the documented
 * shape and the bare status when it is not, which is what something standing in
 * front of the API answers with. A 2xx whose body is not the resource says so,
 * because reporting success there would hand the run an empty message SID.
 */
export function describeTwilioFailure(error: ExternalError): string {
  if (error._tag === "ExternalUnreachable") {
    return error.message;
  }

  if (error._tag === "ExternalUnreadable") {
    return `Twilio answered ${error.status} with an unrecognized body`;
  }

  return readTwilioError(error.payload)?.message ?? `HTTP ${error.status}`;
}

/** Twilio's error body, for a caller that reports more than the message. */
export function readTwilioError(payload: JsonValue | undefined) {
  return parsePayload(payload, twilioErrorSchema);
}

export type TwilioCredentialPair = {
  accountSid: string;
  authToken: string;
};

function toBasicAuth(accountSid: string, authToken: string): string {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
}

function requestTwilio<S extends Schema.ConstraintDecoder<unknown>>(
  credentials: TwilioCredentialPair,
  path: string,
  schema: S,
  init: { method: "GET" | "POST"; body?: URLSearchParams }
): Effect.Effect<S["Type"], ExternalError, HttpClient.HttpClient> {
  return callExternal({
    system: "Twilio",
    url: `${TWILIO_API_BASE}${path}`,
    method: init.method,
    headers: {
      authorization: toBasicAuth(credentials.accountSid, credentials.authToken),
    },
    body:
      init.body === undefined ? undefined : { kind: "form", value: init.body },
    schema,
  });
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
): Effect.Effect<TwilioMessage, ExternalError, HttpClient.HttpClient> {
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
): Effect.Effect<{ sid: string }, ExternalError, HttpClient.HttpClient> {
  return requestTwilio(
    credentials,
    `/Accounts/${encodeURIComponent(credentials.accountSid)}.json`,
    Schema.Struct({ sid: Schema.String }),
    { method: "GET" }
  );
}
