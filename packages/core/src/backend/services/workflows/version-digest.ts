/**
 * Content hashes for publish-gated versions: the graph digest that stops an idle
 * editor from accreting rows, and the catalog fingerprint a version was sound
 * against.
 */

import { createHash } from "node:crypto";
import type { ExtensionCatalog } from "@rova/shared/extensions/catalog";
import { flattenConfigFields } from "@rova/shared/plugins/action-fields";

/**
 * Digest of a graph's JSON, used as the publish dedupe key and (still) as the
 * preflight memo key.
 */
export function graphDigest(graph: unknown): string {
  return createHash("sha1")
    .update(JSON.stringify(graph) ?? "")
    .digest("hex");
}

/**
 * Whether the editable draft differs from the published version.
 *
 * Compares against the version row's own stored digest rather than re-hashing
 * its graph, so a badge read costs one hash, not two. The draft side is hashed
 * as loaded (typically from JSONB), which is why it agrees with a digest
 * computed the same way at publish time. Never-published workflows answer
 * false: the badge for that case is "Never published", not this flag.
 */
export function draftDiffersFromPublished(
  draftGraph: unknown,
  publishedGraphDigest: string | null
): boolean {
  if (publishedGraphDigest == null) {
    return false;
  }
  return graphDigest(draftGraph) !== publishedGraphDigest;
}

/**
 * Fingerprint of the assembled extension catalog surface.
 *
 * Hashes the ids and shapes that decide soundness (Event names, action ids and
 * their config/output field keys, integration types). Handler code is not part
 * of it: two deploys with the same catalog ids share a fingerprint even when
 * step bodies changed, which is Inngest's step-memoization problem rather than
 * this one.
 */
export function catalogFingerprint(catalog: ExtensionCatalog): string {
  const surface = {
    events: catalog.events.map((event) => ({
      name: event.name,
      correlationPath: event.correlationPath ?? null,
      payloadFields: event.payloadFields.map((field) => field.path),
    })),
    actions: catalog.actions.map((action) => ({
      id: action.id,
      integration: action.integration ?? null,
      configFields: flattenConfigFields(action.configFields).map(
        (field) => field.key
      ),
      outputFields: action.outputFields.map((field) => field.path),
    })),
    integrations: catalog.integrations.map((integration) => ({
      type: integration.type,
      credentialKeys: Object.keys(integration.credentialFields),
    })),
  };

  return createHash("sha1").update(JSON.stringify(surface)).digest("hex");
}
