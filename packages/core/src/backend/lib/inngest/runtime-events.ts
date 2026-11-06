import type { Inngest } from "inngest";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { withCatalogConnection } from "#src/backend/lib/inngest/catalog-connection";

/**
 * Forward a catalog Event onto the bus, carrying the Connection it arrived
 * through as an extra key on `data`.
 *
 * Inngest v4 dropped `event.user`: it is not stored and does not survive
 * replay. The vendor envelope stays the rest of `data` (`type`, `created_at`,
 * nested `data`, …) so `source.when` and Correlation Paths keep addressing it.
 * The listener strips the stamp before decode and delivery, so Wait CEL and
 * templates see the envelope the vendor posted.
 *
 * The idempotency id is namespaced by Connection, because the vendor's own id
 * is unique per message and not per endpoint. Two Connections subscribed to the
 * same vendor account receive one message under one id, and passing it through
 * raw would make Inngest read the second Connection's send as a duplicate and
 * drop it. Namespacing keeps a retry to one Connection deduplicated.
 */
export async function sendCatalogEvent(
  client: Inngest,
  input: {
    name: string;
    data: JsonObject;
    connectionId: string;
    id?: string | undefined;
  }
) {
  const event = omitUndefined({
    name: input.name,
    data: withCatalogConnection(input.data, input.connectionId),
    id:
      input.id === undefined
        ? undefined
        : `${input.name}-${input.connectionId}-${input.id}`,
  });
  return await client.send(event);
}
