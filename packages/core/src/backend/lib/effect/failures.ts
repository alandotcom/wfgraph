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
 * Each class carries the payload the caller receives, which for most of them is
 * the single `error` message every service already answers with. A failure that
 * has more to say gets a class of its own carrying those fields, the way
 * `IntegrationValidationFailed` carries the ids it refused, and answers a wider
 * `payload` accordingly.
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

/**
 * What a caller reads off a failure.
 *
 * `error` is the sentence, and the two integration fields are the exception the
 * shape has to make room for: `getRpcErrorMessage` appends the ids to the
 * message when it sees the code, and the editor reads them off the oRPC error's
 * `data` to highlight the offending nodes.
 *
 * Each failure class answers one of these from its `payload` getter, so the
 * shape a caller sees is decided beside the fields it is built from rather than
 * in a switch at the promise seam. The keys stay absent rather than
 * present-and-undefined, so a failure with nothing extra to say serializes to
 * the `{ error }` body it always did.
 */
export type ServiceFailurePayload = {
  error: string;
  code?: string;
  invalidIntegrationIds?: readonly string[];
};

/** The caller's input, or the resource it points at, does not pass validation. */
export class InvalidInput extends Schema.TaggedErrorClass<InvalidInput>()(
  "InvalidInput",
  {
    error: Schema.String,
  }
) {
  readonly kind: Kind<"invalid"> = "invalid";

  get payload(): ServiceFailurePayload {
    return { error: this.error };
  }
}

/**
 * A saved graph points at integrations this server cannot use: an id that no
 * longer exists, or one whose type does not match what the action needs.
 *
 * Its kind is `invalid` like any other rejected input, and the reason it is a
 * class of its own is the list: the editor highlights exactly the nodes it
 * names, so the ids have to survive the trip to the client rather than being
 * flattened into the sentence. Its payload is the `code`/`invalidIntegrationIds`
 * body that `getRpcErrorMessage` reads.
 */
export class IntegrationValidationFailed extends Schema.TaggedErrorClass<IntegrationValidationFailed>()(
  "IntegrationValidationFailed",
  {
    error: Schema.String,
    invalidIntegrationIds: Schema.Array(Schema.String),
  }
) {
  readonly kind: Kind<"invalid"> = "invalid";

  get payload(): ServiceFailurePayload {
    return {
      error: this.error,
      code: "integration_validation_failed",
      invalidIntegrationIds: this.invalidIntegrationIds,
    };
  }
}

/** The caller's credentials did not authenticate. */
export class Unauthorized extends Schema.TaggedErrorClass<Unauthorized>()(
  "Unauthorized",
  {
    error: Schema.String,
  }
) {
  readonly kind: Kind<"unauthorized"> = "unauthorized";

  get payload(): ServiceFailurePayload {
    return { error: this.error };
  }
}

/** The addressed resource does not exist. */
export class NotFound extends Schema.TaggedErrorClass<NotFound>()("NotFound", {
  error: Schema.String,
}) {
  readonly kind: Kind<"not_found"> = "not_found";

  get payload(): ServiceFailurePayload {
    return { error: this.error };
  }
}

/** The request collides with existing state, such as a duplicate name. */
export class Conflict extends Schema.TaggedErrorClass<Conflict>()("Conflict", {
  error: Schema.String,
}) {
  readonly kind: Kind<"conflict"> = "conflict";

  get payload(): ServiceFailurePayload {
    return { error: this.error };
  }
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

  // `cause` is for the operator-facing log, so it stays out of the payload.
  get payload(): ServiceFailurePayload {
    return { error: this.error };
  }
}

/** Every failure a migrated service may answer with. */
export type ServiceFailure =
  | InvalidInput
  | IntegrationValidationFailed
  | Unauthorized
  | NotFound
  | Conflict
  | InternalFailure;
