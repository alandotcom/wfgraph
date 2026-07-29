/**
 * The one HTTP call a plugin makes to a vendor.
 *
 * Every vendor client here needs the same six things: put headers on a request,
 * give up on a request that hangs, survive a transport that throws, read a JSON
 * body back, tell "the request never arrived" apart from "the vendor said no",
 * and come back a moment later when the vendor asked for a moment. Writing that
 * once leaves each client holding only what is genuinely its own: how it
 * authenticates, how it encodes a body, and what its error payload looks like.
 *
 * The response body is decoded against a schema at this boundary rather than
 * being read field by field, so a client hands its caller typed values and a
 * vendor that answers something unexpected fails where it happened instead of
 * further down as an empty string.
 *
 * The transport is Effect's own `HttpClient` over `fetch`, which is what makes
 * the timeout, the retry schedule, and the trace span operators on one effect
 * rather than six pieces of bookkeeping in each client.
 */

import { VendorTransport } from "@rova/core/plugin";
import { Duration, Effect, Option, Schedule, Schema } from "effect";
import {
  Headers,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
  type HttpMethod,
} from "effect/unstable/http";
import {
  type JsonObject,
  type JsonValue,
  readJsonValue,
} from "@rova/shared/types/json";

/**
 * How long one attempt may take before the vendor counts as unreachable.
 *
 * There was no timeout here at all before, which left a hung connection holding
 * a workflow run open until something upstream gave up. Ten seconds is longer
 * than any of these APIs takes to answer and short enough that a retry still
 * fits inside an Inngest step.
 */
const ATTEMPT_TIMEOUT = Duration.seconds(10);

/**
 * The retry policy, stated once.
 *
 * Two retries after the first attempt, spaced by an exponential backoff from
 * 500ms with jitter, and a `Retry-After` the vendor sent replaces that delay
 * outright. A request only enters this loop when repeating it cannot do the
 * work twice (see `isSafeToRepeat`) and only for a failure a repeat could
 * plausibly fix (see `isWorthRetrying`).
 *
 * This is the inner policy and it is deliberately short: it exists for the
 * hiccup that is over in a second, a rate limit the vendor already told us how
 * long to wait out, and a connection that never opened. Everything else is the
 * engine's business, where Inngest's function-level retry re-runs the whole
 * step minutes later with a much longer reach than anything sensible to hold a
 * socket open for.
 */
const RETRY_ATTEMPTS = 2;
const RETRY_BASE_DELAY = Duration.millis(500);

/**
 * The longest `Retry-After` this module will sit through.
 *
 * A vendor that asks for more than this is not having a hiccup, so the failure
 * goes out to the engine instead, which can come back in ten minutes without
 * holding anything open in the meantime.
 */
const RETRY_AFTER_CEILING_SECONDS = 10;

/**
 * How long the loop may already have been running when it decides to go again.
 *
 * Three attempts of ten seconds with two `Retry-After` waits at the ceiling
 * between them is fifty seconds, far longer than an Inngest step should stay
 * open for a hiccup. `Schedule.upTo` measures elapsed time from the first
 * failure and reads it at the moment the next failure arrives, so the budget
 * bounds the time already spent rather than the time still to come. Ten
 * seconds, one attempt's worth, brings the worst case to forty (a 10s first
 * attempt, 10s of budget, one 10s wait, one 10s attempt) while leaving the case
 * this loop exists for, a failure that comes back in well under a second, with
 * both of its retries.
 */
const RETRY_TOTAL_BUDGET = Duration.seconds(10);

/** The request never got an answer: nothing opened, or the timeout fired. */
export class VendorUnreachable extends Schema.TaggedErrorClass<VendorUnreachable>()(
  "VendorUnreachable",
  {
    message: Schema.String,
  }
) {}

/**
 * The vendor answered and refused.
 *
 * `payload` is whatever JSON came with the refusal, for the client to read its
 * vendor's error envelope out of; it is absent when the body was not JSON.
 * `retryAfterSeconds` is the header's delta-seconds form, absent when the
 * vendor sent no `Retry-After` or sent it in some other form, such as the
 * HTTP-date one, which none of these vendors uses and this module does not read.
 */
export class VendorRejected extends Schema.TaggedErrorClass<VendorRejected>()(
  "VendorRejected",
  {
    status: Schema.Finite,
    // `TaggedErrorClass` wants a schema per field and shared exports none for
    // `JsonValue`, so the payload is described with Effect's own JSON schema.
    payload: Schema.UndefinedOr(Schema.MutableJson),
    retryAfterSeconds: Schema.UndefinedOr(Schema.Finite),
  }
) {}

/** A success status whose body is not the shape the caller asked for. */
export class VendorUnreadable extends Schema.TaggedErrorClass<VendorUnreadable>()(
  "VendorUnreadable",
  {
    status: Schema.Finite,
  }
) {}

export type VendorError = VendorUnreachable | VendorRejected | VendorUnreadable;

/**
 * A body, in the encoding the vendor asks for. Twilio takes form parameters,
 * Slack and Resend take JSON.
 */
export type VendorBody =
  | { readonly kind: "json"; readonly value: JsonObject }
  | { readonly kind: "form"; readonly value: URLSearchParams };

export type VendorRequest<S extends Schema.ConstraintDecoder<unknown>> = {
  /** How the vendor is named in the one message this module writes itself. */
  readonly vendor: string;
  readonly url: string;
  readonly method: HttpMethod.HttpMethod;
  readonly headers: Record<string, string>;
  readonly body?: VendorBody;
  /** What a success body must decode to. Anything else is `VendorUnreadable`. */
  readonly schema: S;
  /**
   * Sent as `idempotency-key`, and the reason a POST carrying one may be
   * retried: the vendor replays its first answer rather than doing the work
   * twice.
   */
  readonly idempotencyKey?: string;
  /**
   * Reads a refusal out of a success body. Slack needs this: every call it
   * answers arrives as 200, and `ok: false` with an error slug is how it says
   * no, which a status check alone would read as success. Answering true turns
   * that body into the same `VendorRejected` a 4xx produces.
   */
  readonly refusedInBody?: (payload: JsonValue | undefined) => boolean;
  /**
   * Widens the repeat-safety rule for a request the caller knows better about,
   * such as a read that a vendor's API insists on spelling as a POST. Setting
   * it is the only thing a caller can say here: a GET, a HEAD, and a write
   * carrying an idempotency key are repeatable by construction, so there is
   * nothing for a caller to take back.
   */
  readonly safeToRepeat?: true;
};

/**
 * Ask a vendor for something and get back what it said, decoded.
 *
 * The effect fails with a `VendorError` for every way the call can go wrong,
 * so a client's own failure vocabulary is a mapping over three cases rather
 * than a pipeline of its own.
 */
export function callVendor<S extends Schema.ConstraintDecoder<unknown>>(
  request: VendorRequest<S>
): Effect.Effect<S["Type"], VendorError, HttpClient.HttpClient> {
  const attempt = attemptCall(request);

  if (!isSafeToRepeat(request)) {
    return attempt;
  }

  return Effect.retry(attempt, {
    schedule: retrySchedule,
    while: isWorthRetrying,
  });
}

/**
 * Run a vendor call for a caller that is still a Promise.
 *
 * A step written with `defineStep` runs its own effect and is given the
 * transport, so this is for the callers that are not one yet: the steps stage
 * 6b has still to migrate, and a connection test, which answers the credentials
 * UI over its own Promise seam.
 *
 * Only a `VendorError` becomes a result object. A defect, a `refusedInBody` that
 * throws among them, rejects the returned Promise, which is what the old code
 * did with a thrown error too.
 */
export function runVendorCall<A, TFailure>(
  call: Effect.Effect<A, VendorError, HttpClient.HttpClient>,
  toFailure: (error: VendorError) => TFailure
): Promise<VendorCallResult<A, TFailure>> {
  return Effect.runPromise(
    call.pipe(
      Effect.match({
        onSuccess: (data): VendorCallResult<A, TFailure> => ({
          ok: true,
          data,
        }),
        onFailure: (error): VendorCallResult<A, TFailure> => ({
          ok: false,
          failure: toFailure(error),
        }),
      }),
      Effect.provide(VendorTransport)
    )
  );
}

export type VendorCallResult<A, TFailure> =
  | { ok: true; data: A }
  | { ok: false; failure: TFailure };

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

/** One trip to the vendor, with the timeout that bounds it. */
function attemptCall<S extends Schema.ConstraintDecoder<unknown>>(
  request: VendorRequest<S>
): Effect.Effect<S["Type"], VendorError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(buildRequest(request))
      .pipe(Effect.mapError(unreachableFrom));
    const payload = yield* readPayload(response);

    const refused =
      !isSuccessStatus(response.status) ||
      request.refusedInBody?.(payload) === true;

    if (refused) {
      return yield* Effect.fail(
        new VendorRejected({
          status: response.status,
          payload,
          retryAfterSeconds: readRetryAfter(response.headers),
        })
      );
    }

    const data = parsePayload(payload, request.schema);
    if (data === undefined) {
      // A success status the vendor did not shape the way it documents.
      // Reporting success here would hand the run an empty id and call it sent.
      return yield* Effect.fail(
        new VendorUnreadable({ status: response.status })
      );
    }

    return data;
  }).pipe(
    Effect.timeoutOrElse({
      duration: ATTEMPT_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new VendorUnreachable({
            message: `${request.vendor} did not answer within ${Duration.format(ATTEMPT_TIMEOUT)}`,
          })
        ),
    })
  );
}

function buildRequest<S extends Schema.ConstraintDecoder<unknown>>(
  request: VendorRequest<S>
): HttpClientRequest.HttpClientRequest {
  const bare = HttpClientRequest.make(request.method)(request.url);
  const withBody = encodeBody(bare, request.body);

  const headers =
    request.idempotencyKey === undefined
      ? request.headers
      : { ...request.headers, "idempotency-key": request.idempotencyKey };

  // The caller's headers go on last so that a vendor asking for a content type
  // of its own, the way Slack asks for a charset suffix, wins over the one the
  // body encoding put there.
  return HttpClientRequest.setHeaders(withBody, headers);
}

function encodeBody(
  request: HttpClientRequest.HttpClientRequest,
  body: VendorBody | undefined
): HttpClientRequest.HttpClientRequest {
  if (body === undefined) {
    return request;
  }

  return body.kind === "json"
    ? HttpClientRequest.bodyJsonUnsafe(request, body.value)
    : HttpClientRequest.bodyUrlParams(request, body.value);
}

/**
 * The body as JSON, or undefined when there was not one to read: a 204, an
 * empty body, or HTML from something standing in front of the vendor. The
 * status is then the whole story.
 */
function readPayload(
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<JsonValue | undefined> {
  return response.json.pipe(
    Effect.map((body) => readJsonValue(body) ?? undefined),
    Effect.orElseSucceed(() => undefined)
  );
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function readRetryAfter(headers: Headers.Headers): number | undefined {
  const header = Option.getOrUndefined(Headers.get(headers, "retry-after"));
  if (header === undefined) {
    return undefined;
  }

  // RFC 9110 writes the form this module reads as digits and nothing else, so
  // the digits are checked before the conversion. `Number` would otherwise read
  // "1e3" as a thousand seconds, "0x10" as sixteen, and an empty header, which
  // is what `Headers` makes of a whitespace-only one, as zero. That zero is the
  // damaging one: it satisfies the 5xx-with-a-`Retry-After` case in
  // `isWorthRetrying` and then names no delay at all, so a bare 500 carrying an
  // empty header would be sent twice more on the spot.
  if (!/^\d+$/.test(header)) {
    return undefined;
  }

  // A digit string long enough to overflow is still not a number of seconds.
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/**
 * Whatever the transport threw, said in the words the caller used to get.
 *
 * `HttpClientError` copies the raw rejection onto its own `cause`, so this is
 * the `fetch` rejection itself rather than the wrapper's formatted message.
 */
function unreachableFrom(
  error: HttpClientError.HttpClientError
): VendorUnreachable {
  const cause: unknown = error.cause ?? error;
  if (cause instanceof Error) {
    return new VendorUnreachable({ message: cause.message });
  }

  return new VendorUnreachable({
    message: typeof cause === "string" ? cause : JSON.stringify(cause),
  });
}

/**
 * Whether sending this request a second time can do the work twice.
 *
 * A GET or a HEAD cannot by definition, and neither can a write carrying an
 * idempotency key, since the vendor replays its first answer for a repeat. Every
 * other write can, so a send that timed out on the way back stays sent once,
 * unless the caller vouched for it with `safeToRepeat`.
 */
function isSafeToRepeat<S extends Schema.ConstraintDecoder<unknown>>(
  request: VendorRequest<S>
): boolean {
  return (
    request.safeToRepeat === true ||
    request.method === "GET" ||
    request.method === "HEAD" ||
    request.idempotencyKey !== undefined
  );
}

/**
 * Whether a repeat could plausibly answer differently.
 *
 * Nothing arriving at all, a rate limit, and a vendor reporting itself
 * unavailable are the three. Any other 5xx joins them only when it carried a
 * `Retry-After`, which is the vendor saying in as many words that coming back
 * is the right move. A 500 on its own is as often a deterministic refusal as a
 * hiccup, so it is not retried.
 */
function isWorthRetrying(error: VendorError): boolean {
  if (error._tag === "VendorUnreachable") {
    return true;
  }

  if (error._tag !== "VendorRejected") {
    return false;
  }

  const retryAfter = error.retryAfterSeconds;
  if (retryAfter !== undefined && retryAfter > RETRY_AFTER_CEILING_SECONDS) {
    return false;
  }

  return (
    error.status === 429 ||
    error.status === 503 ||
    (error.status >= 500 && retryAfter !== undefined)
  );
}

const retrySchedule = Schedule.exponential(RETRY_BASE_DELAY, 2).pipe(
  Schedule.jittered,
  Schedule.setInputType<VendorError>(),
  // A `Retry-After` replaces the backoff rather than adding to it: the vendor
  // has named the moment it will answer again, and a longer wait is politeness
  // nobody asked for while a shorter one is the request that got us here.
  Schedule.modifyDelay(({ duration, input }) => {
    const retryAfter =
      input._tag === "VendorRejected" ? input.retryAfterSeconds : undefined;
    return Effect.succeed(
      retryAfter === undefined ? duration : Duration.seconds(retryAfter)
    );
  }),
  Schedule.upTo({ times: RETRY_ATTEMPTS, duration: RETRY_TOTAL_BUDGET })
);
