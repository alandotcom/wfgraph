/**
 * The Connection stamp an integration-owned Event carries on its Inngest `data`.
 *
 * Its own module because `assembleExtensions` needs the reserved key to refuse a
 * colliding Event declaration, and reaching into `runtime-events` for it would
 * pull the Inngest SDK into the catalog's module graph. Nothing here imports
 * Inngest; the senders that do are in `runtime-events.ts`.
 */

import { Result, Schema } from "effect";
import { omit } from "es-toolkit/object";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { NonEmptyTrimmedString } from "@wfgraph/shared/types/schema";

/**
 * The key the Connection stamp travels under.
 *
 * Prefixed rather than plain, because the rest of `data` is a vendor envelope
 * this app does not control: a vendor sending its own `connectionId` would
 * otherwise have that value overwritten on the way out and deleted on the way
 * in. `assembleExtensions` refuses an integration Event declaring a payload
 * field under this key, so the only collision left is a vendor inventing the
 * same prefix.
 */
export const CONNECTION_STAMP_KEY = "__wfgraphConnectionId";

const readCatalogConnection = Schema.decodeUnknownResult(
  Schema.Struct({ [CONNECTION_STAMP_KEY]: NonEmptyTrimmedString })
);

/** Stamp the Connection onto a vendor envelope for the Inngest send. */
export function withCatalogConnection(
  data: JsonObject,
  connectionId: string
): JsonObject {
  return { ...data, [CONNECTION_STAMP_KEY]: connectionId };
}

/**
 * Split the Connection stamp off a catalog Event's `data`.
 *
 * Only the integration send path stamps a Connection, so a host Event's `data`
 * comes back as it arrived.
 */
export function splitCatalogEventData(
  data: JsonObject,
  input: { connectionStamped: boolean }
): {
  payload: JsonObject;
  connectionId: string | undefined;
} {
  if (!input.connectionStamped) {
    return { payload: data, connectionId: undefined };
  }
  const parsed = readCatalogConnection(data);
  if (Result.isFailure(parsed)) {
    return { payload: data, connectionId: undefined };
  }
  return {
    payload: omit(data, [CONNECTION_STAMP_KEY]),
    connectionId: parsed.success[CONNECTION_STAMP_KEY],
  };
}
