import { ORPCError } from "@orpc/server";
import type {
  ServiceFailure,
  ServiceFailureKind,
} from "#src/backend/lib/effect/failures";
import { getRpcErrorMessage } from "@wfgraph/shared/rpc/error-message";

const FAILURE_KIND_TO_ORPC_CODE = {
  invalid: "BAD_REQUEST",
  unauthorized: "UNAUTHORIZED",
  not_found: "NOT_FOUND",
  conflict: "CONFLICT",
  internal: "INTERNAL_SERVER_ERROR",
} as const satisfies Record<ServiceFailureKind, string>;

/**
 * One of the two edges: a domain failure becomes the oRPC error a procedure
 * throws.
 *
 * The failure's own `payload` is both the message source and the `data` the
 * client reads, which is how the integration failures carry their ids through
 * to the editor. oRPC derives the wire status from the code, so nothing here
 * names one.
 */
export function toOrpcError(
  failure: ServiceFailure
): ORPCError<string, unknown> {
  const payload = failure.payload;

  return new ORPCError(FAILURE_KIND_TO_ORPC_CODE[failure.kind], {
    message: getRpcErrorMessage(payload),
    data: payload,
  });
}
