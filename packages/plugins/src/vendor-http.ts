/**
 * The one HTTP call a plugin makes to a vendor.
 *
 * Every vendor client here needs the same four things: put headers on a
 * request, survive a `fetch` that throws, read a JSON body back, and tell "the
 * request never arrived" apart from "the vendor said no". Writing that once
 * leaves each client holding only what is genuinely its own: how it
 * authenticates, how it encodes a body, and what its error payload looks like.
 *
 * The response body is decoded against a schema at this boundary rather than
 * being read field by field, so a client hands its caller typed values and a
 * vendor that answers something unexpected fails where it happened instead of
 * further down as an empty string.
 */

import { Option, Schema } from "effect";
import { type JsonValue, readJsonValue } from "@rova/shared/types/json";

/**
 * What came back, before any vendor's meaning is read into it.
 *
 * `unreachable` is the case with no HTTP status to report, which is why it is a
 * separate variant rather than a zero standing in for one.
 */
export type VendorResponse =
  | { kind: "unreachable"; message: string }
  | {
      kind: "answered";
      status: number;
      ok: boolean;
      /** Undefined for an empty body, a 204, or a body that is not JSON. */
      payload: JsonValue | undefined;
    };

export type VendorRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: BodyInit;
};

export async function requestVendor(
  request: VendorRequest
): Promise<VendorResponse> {
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
  } catch (error) {
    return {
      kind: "unreachable",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    kind: "answered",
    status: response.status,
    ok: response.ok,
    payload: await readJsonBody(response),
  };
}

async function readJsonBody(
  response: Response
): Promise<JsonValue | undefined> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    // An empty body, a 204, or HTML from something in front of the vendor. The
    // HTTP status is then the whole story.
    return undefined;
  }

  return readJsonValue(parsed) ?? undefined;
}

/**
 * Read a payload as the shape a vendor documents, or undefined when it is not
 * that shape. Callers decide what an unreadable body means for them: a failed
 * send should say so rather than report success with blank fields.
 *
 * This is `readAs` from `@rova/shared/types/schema` with its compile-time guard
 * dropped, which is what lets a caller ask for nothing in particular. A vendor
 * client checking that credentials work only needs a body to have arrived, and
 * `Schema.Unknown` says exactly that; the absent body it would otherwise read as
 * a value is already the caller's failure case here.
 */
export function parsePayload<S extends Schema.ConstraintDecoder<unknown>>(
  payload: JsonValue | undefined,
  schema: S
): S["Type"] | undefined {
  return Option.getOrUndefined(Schema.decodeUnknownOption(schema)(payload));
}
