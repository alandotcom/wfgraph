import { Schema } from "effect";
import type { ServiceFailureKind } from "#src/backend/lib/service-result";

/**
 * Why a service call failed, as a tagged error the type system can see.
 *
 * These are the Effect half of `ServiceFailureKind`: one class per kind, meaning
 * exactly what the doc comment on that type says. A service written with Effect
 * puts one of these in its error channel instead of returning
 * `failure(kind, payload)`, so a caller that forgets a failure case stops
 * compiling rather than reading `result.ok` and moving on.
 *
 * Each class carries the payload the caller receives, which today is the single
 * `error` message every service already answers with. A service that needs to
 * say more (the integration validation path sends a `code` and a list of ids)
 * adds those as optional fields on the class it fails with, and the payload
 * `runToServiceResult` builds grows to pass them through.
 *
 * The two adapters at the edges keep translating: `backend/rpc/errors.ts` turns
 * a kind into an oRPC code, `backend/lib/http/response-from-service-result.ts`
 * into an HTTP status. Nothing here names a status code.
 *
 * These classes are schema-backed but nothing encodes or decodes them today:
 * they are constructed in a service and read at the promise seam, both inside
 * one process. Stage 4 of ADR-0002 owns the wire representation, when Effect
 * Schema reaches the RPC contracts and a failure has to survive the trip to a
 * client. `Schema.TaggedErrorClass` rather than `Data.TaggedError` is the
 * deliberate choice that leaves that door open.
 */

/**
 * The single kind one failure class means, checked against the full set.
 *
 * Written as a constraint rather than as `kind: ServiceFailureKind` so that each
 * class keeps its own literal: that is what lets `runToServiceResult` report the
 * two kinds a service can actually produce instead of all five.
 */
type Kind<K extends ServiceFailureKind> = K;

/** The caller's input, or the resource it points at, does not pass validation. */
export class InvalidInput extends Schema.TaggedErrorClass<InvalidInput>()(
  "InvalidInput",
  {
    error: Schema.String,
  }
) {
  readonly kind: Kind<"invalid"> = "invalid";
}

/** The caller's credentials did not authenticate. */
export class Unauthorized extends Schema.TaggedErrorClass<Unauthorized>()(
  "Unauthorized",
  {
    error: Schema.String,
  }
) {
  readonly kind: Kind<"unauthorized"> = "unauthorized";
}

/** The addressed resource does not exist. */
export class NotFound extends Schema.TaggedErrorClass<NotFound>()("NotFound", {
  error: Schema.String,
}) {
  readonly kind: Kind<"not_found"> = "not_found";
}

/** The request collides with existing state, such as a duplicate name. */
export class Conflict extends Schema.TaggedErrorClass<Conflict>()("Conflict", {
  error: Schema.String,
}) {
  readonly kind: Kind<"conflict"> = "conflict";
}

/**
 * Something failed on our side and the caller cannot fix it.
 *
 * `cause` holds whatever was thrown underneath, so the operator-facing log keeps
 * the detail while the caller-facing `error` stays a sentence a UI can show.
 */
export class InternalFailure extends Schema.TaggedErrorClass<InternalFailure>()(
  "InternalFailure",
  {
    error: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {
  readonly kind: Kind<"internal"> = "internal";
}

/** Every failure a migrated service may answer with. */
export type ServiceFailure =
  | InvalidInput
  | Unauthorized
  | NotFound
  | Conflict
  | InternalFailure;
