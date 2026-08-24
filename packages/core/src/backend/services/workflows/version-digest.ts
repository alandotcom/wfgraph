/**
 * Content hashes for the semantic graph identity and the extension catalog a
 * published version was sound against.
 */

import { createHash } from "node:crypto";
import { sortBy } from "es-toolkit/array";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { flattenConfigFields } from "@wfgraph/shared/plugins/action-fields";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import { isSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import {
  normalizeSemanticValue,
  projectSemanticWorkflowGraph,
  semanticValueKey,
  semanticWorkflowGraphsEqual,
} from "#src/backend/services/workflows/semantic-graph";

/**
 * Digest of a graph's canonical semantic projection. The projection ignores
 * editor layout and generated edge ids, while SHA-256 protects the persisted
 * identity from accidental collisions.
 */
export function graphDigest(graph: unknown): string {
  const projected = isSerializedWorkflowGraph(graph)
    ? projectSemanticWorkflowGraph(graph)
    : normalizeSemanticValue(graph);
  return createHash("sha256")
    .update(projected === undefined ? "" : semanticValueKey(projected))
    .digest("hex");
}

/**
 * Whether the editable draft differs from the published version.
 *
 * Reads the published graph because existing rows can carry a digest produced
 * by an older algorithm. Never-published workflows answer false because their
 * badge has its own state.
 */
export function draftDiffersFromPublished(
  draftGraph: SerializedWorkflowGraph,
  publishedGraph: SerializedWorkflowGraph | null
): boolean {
  if (publishedGraph == null) {
    return false;
  }
  return !semanticWorkflowGraphsEqual(draftGraph, publishedGraph);
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
