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
 * password.
 */

import { omitBy } from "es-toolkit/object";
import { isNil } from "es-toolkit/predicate";
import { z } from "zod";
import { parsePayload, requestVendor } from "@/vendor-http";

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

/** Twilio's error body, the same shape on every endpoint. */
const twilioErrorSchema = z.object({
  code: z.number().optional(),
  message: z.string().optional(),
  more_info: z.string().optional(),
});

/** The Message resource, as much of it as this plugin reads. */
const twilioMessageSchema = z.object({
  sid: z.string(),
  status: z.string(),
  to: z.string(),
  from: z.string().nullish(),
  messaging_service_sid: z.string().nullish(),
});

export type TwilioMessage = z.infer<typeof twilioMessageSchema>;

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

async function requestTwilio<TSchema extends z.ZodType>(
  credentials: TwilioCredentialPair,
  path: string,
  schema: TSchema,
  init: { method: string; body?: URLSearchParams }
): Promise<TwilioResult<z.infer<TSchema>>> {
  const headers: Record<string, string> = {
    authorization: toBasicAuth(credentials.accountSid, credentials.authToken),
  };
  if (init.body) {
    headers["content-type"] = "application/x-www-form-urlencoded";
  }

  const response = await requestVendor({
    url: `${TWILIO_API_BASE}${path}`,
    method: init.method,
    headers,
    body: init.body,
  });

  if (response.kind === "unreachable") {
    return { ok: false, failure: response };
  }

  if (!response.ok) {
    const error = parsePayload(response.payload, twilioErrorSchema);
    return {
      ok: false,
      failure: {
        kind: "rejected",
        status: response.status,
        message: error?.message ?? `HTTP ${response.status}`,
        code: error?.code,
        moreInfo: error?.more_info,
      },
    };
  }

  const data = parsePayload(response.payload, schema);
  if (data === undefined) {
    // A 2xx Twilio did not shape the way it documents. Reporting success here
    // would hand the run an empty message SID and call it sent.
    return {
      ok: false,
      failure: { kind: "unreadable", status: response.status },
    };
  }

  return { ok: true, data };
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
    z.object({ sid: z.string() }),
    { method: "GET" }
  );
}
