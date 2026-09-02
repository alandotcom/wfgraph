import { Schema } from "effect";
import {
  INTEGRATION_VALIDATION_FAILED_CODE,
  PUBLICATION_CONFLICT_CODE_VALUES,
} from "@wfgraph/shared/rpc/error-codes";

/**
 * Why a service call failed, stated in the domain's own terms.
 *
 * Services answer with one of these rather than an HTTP status, so that nothing
 * inside the backend has to know how a failure will eventually be transported.
 * The adapters at the edges each translate a kind into whatever their transport
 * expects.
 *
 * - `invalid`: the caller's input or the resource it points at does not pass validation.
 * - `unauthorized`: the caller's credentials did not authenticate. This is distinct from
 *   `invalid` because the wait resume endpoint is reached by third parties, who need
 *   to tell a rejected API key apart from a malformed request.
 * - `not_found`: the addressed resource does not exist.
 * - `conflict`: the request collides with existing state, such as a duplicate name.
 * - `internal`: something failed on our side and the caller cannot fix it.
 */
export type ServiceFailureKind =
  | "invalid"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "internal";

/**
 * Why a service call failed, as a tagged error the type system can see.
 *
 * One class per kind, meaning exactly what the doc comment above says. A service
 * puts one of these in its error channel, so a caller that forgets a failure
 * case stops compiling rather than reading a flag and moving on.
 *
 * Each class carries the payload the caller receives, which for most of them is
 * the single `error` message every service already answers with. A failure that
 * has more to say gets a class of its own carrying those fields, the way
 * `IntegrationValidationFailed` carries the ids it refused, and answers a wider
 * `payload` accordingly.
 *
 * The two adapters at the edges keep translating: `backend/rpc/errors.ts` turns
 * a kind into an oRPC code, `backend/lib/http/failure-response.ts` into an HTTP
 * status. Nothing here names a status code.
 *
 * These classes are schema-backed but nothing encodes or decodes them today:
 * they are constructed in a service and read at the promise seam, both inside
 * one process. Stage 4 of ADR-0002 owns the wire representation, when Effect
 * Schema reaches the RPC contracts and a failure has to survive the trip to a
 * client. `Schema.TaggedError` rather than `Data.TaggedError` is the
 * deliberate choice that leaves that door open.
 */

/**
 * The single kind one failure class means, checked against the full set.
 *
 * Written as a constraint rather than as `kind: ServiceFailureKind` so that each
 * class keeps its own literal, which is what lets a caller narrowing on a
 * service's failures see only the kinds that service can actually produce.
 */
type Kind<K extends ServiceFailureKind> = K;

/**
 * What a caller reads off a failure.
 *
 * `error` is the sentence, and the two integration fields are the exception the
 * shape has to make room for: `getRpcErrorMessage` reads the code and appends
 * the ids to the message it builds, and it is the only consumer of them today.
 *
 * Each failure class answers one of these from its `payload` getter, so the
 * shape a caller sees is decided beside the fields it is built from rather than
 * in a switch at the promise seam. The keys stay absent rather than
 * present-and-undefined, so a failure with nothing extra to say serializes to
 * the `{ error }` body it always did.
 */
export type ServiceFailurePayload = {
  error: string;
  code?: string | undefined;
  invalidIntegrationIds?: readonly string[] | undefined;
};

/** The caller's input, or the resource it points at, does not pass validation. */
export class InvalidInput extends Schema.TaggedError<InvalidInput>()(
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
 * class of its own is the list: the ids travel to the client as data rather than
 * flattened into the sentence. Its payload is the `code`/`invalidIntegrationIds`
 * body that `getRpcErrorMessage` reads, which appends the ids to the message it
 * builds and is the only thing that reads them today.
 */
export class IntegrationValidationFailed extends Schema.TaggedError<IntegrationValidationFailed>()(
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
      code: INTEGRATION_VALIDATION_FAILED_CODE,
      invalidIntegrationIds: this.invalidIntegrationIds,
    };
  }
}

/** The caller's credentials did not authenticate. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
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
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  error: Schema.String,
}) {
  readonly kind: Kind<"not_found"> = "not_found";

  get payload(): ServiceFailurePayload {
    return { error: this.error };
  }
}

/** The request collides with existing state, such as a duplicate name. */
export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  error: Schema.String,
}) {
  readonly kind: Kind<"conflict"> = "conflict";

  get payload(): ServiceFailurePayload {
    return { error: this.error };
  }
}

/**
 * A publish collided with the publication state it was reviewed against.
 *
 * Its kind is `conflict` like any other collision, and the reason it is a class
 * of its own is the code: the editor has a different recovery for each of the
 * two cases. A stale claim ends the review the user approved and reloads the
 * publication state; a graph that is already published closes the review and
 * says there was nothing to send. Both recoveries read `code` off the payload,
 * because the sentence beside it is written for a person and may be reworded.
 *
 * The two codes are the whole set. Any other collision stays a plain
 * `Conflict`.
 */
export class PublicationConflict extends Schema.TaggedError<PublicationConflict>()(
  "PublicationConflict",
  {
    error: Schema.String,
    code: Schema.Literals(PUBLICATION_CONFLICT_CODE_VALUES),
  }
) {
  readonly kind: Kind<"conflict"> = "conflict";

  get payload(): ServiceFailurePayload {
    return { error: this.error, code: this.code };
  }
}

/**
 * Something failed on our side and the caller cannot fix it.
 *
 * `cause` holds whatever was thrown underneath, so the operator-facing log keeps
 * the detail while the caller-facing `error` stays a sentence a UI can show.
 */
export class InternalFailure extends Schema.TaggedError<InternalFailure>()(
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
  | PublicationConflict
  | InternalFailure;
