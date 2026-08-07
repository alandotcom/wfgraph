/**
 * Content hashes for publish-gated versions: the graph digest that stops an idle
 * editor from accreting rows, and the catalog fingerprint a version was sound
 * against.
 */

import { createHash } from "node:crypto";
import { sortBy } from "es-toolkit/array";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { flattenConfigFields } from "@wfgraph/shared/plugins/action-fields";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * `JSON.stringify` with every object's keys sorted, recursively. Postgres
 * jsonb does not keep the key order a value was written with (a node written
 * as `{id, type, position, data}` reads back `{id, data, type, position}`),
 * so a digest taken before storage and one taken after must serialize through
 * this rather than through `JSON.stringify` directly, or the two disagree on
 * content that is otherwise identical.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

/**
 * Digest of a graph's JSON, used as the publish dedupe key and (still) as the
 * preflight memo key. Order-independent (see `canonicalize`) and SHA-256:
 * SHA-1 is broken for collision resistance and has no place in a new digest.
 * Changing the algorithm does not touch stored rows — an old version's
 * `graphDigest` column keeps its SHA-1 value, which simply stops matching a
 * freshly computed SHA-256 one, so publish mints a new version once instead
 * of reusing it.
 */
export function graphDigest(graph: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(graph)) ?? "")
    .digest("hex");
}

/**
 * Whether the editable draft differs from the published version.
 *
 * Compares against the version row's own stored digest rather than re-hashing
 * its graph, so a badge read costs one hash, not two. This is safe only
 * because `graphDigest` is order-independent: the draft side is hashed as
 * loaded from JSONB, whose key order need not match what was hashed at
 * publish time, and the two must still agree when the content does.
 * Never-published workflows answer false: the badge for that case is "Never
 * published", not this flag.
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
 *
 * Every list is sorted first. A version pins this value, and each later run of
 * that version compares the live one against it
 * (`engine/strategies/plugin-action.ts`). The catalog arrives in the order the
 * host declared it, so reading that order would fail every published workflow
 * with a republish notice over an edit that renamed nothing.
 *
 * SHA-256 for the reason `graphDigest` gives: a collision here reads a changed
 * surface as unchanged, which is the one failure this catches.
 */
export function catalogFingerprint(catalog: ExtensionCatalog): string {
  const surface = {
    events: sortBy(
      catalog.events.map((event) => ({
        name: event.name,
        correlationPath: event.correlationPath ?? null,
        payloadFields: event.payloadFields
          .map((field) => field.path)
          .toSorted(),
      })),
      ["name"]
    ),
    actions: sortBy(
      catalog.actions.map((action) => ({
        id: action.id,
        integration: action.integration ?? null,
        configFields: flattenConfigFields(action.configFields)
          .map((field) => field.key)
          .toSorted(),
        outputFields: action.outputFields.map((field) => field.path).toSorted(),
      })),
      ["id"]
    ),
    integrations: sortBy(
      catalog.integrations.map((integration) => ({
        type: integration.type,
        credentialKeys: Object.keys(integration.credentialFields).toSorted(),
      })),
      ["type"]
    ),
  };

  return createHash("sha256").update(JSON.stringify(surface)).digest("hex");
}
