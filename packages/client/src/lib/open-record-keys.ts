/**
 * The keys an open record actually holds in this workflow, read off the graph.
 *
 * A record accepts keys no schema can list, so the catalog can only say what a
 * key would carry, never which ones exist. The graph often knows: a Send Email
 * node tagged `name` is the reason `tags.name` is a real path, on that node's
 * own output and on the `resend/email.*` Events that carry the same tags back.
 * A `key-value` config field says which records its names fill, with
 * `fillsRecords` (`packages/shared/src/plugins/action-fields.ts`), and this is
 * what collects them.
 *
 * Scoped to one integration, so PostHog's property names never turn up as
 * Resend's tag keys. Suggestions rather than a guarantee: an email tagged by
 * something outside this workflow carries keys no node here names, so a key
 * typed by hand still resolves whether it was offered or not.
 */

import { uniq } from "es-toolkit/array";
import {
  type ExtensionCatalog,
  findAction,
} from "@wfgraph/shared/extensions/catalog";
import { readConfigString } from "@wfgraph/shared/graph/node-config";
import { flattenConfigFields } from "@wfgraph/shared/plugins/action-fields";
import { readKeyValueRows } from "@wfgraph/shared/plugins/key-value-rows";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";

/**
 * The keys this graph fills each record with, by integration and record path.
 *
 * One map for the whole graph, because a record is filled where the email is
 * sent and read where its Event arrives, and those are different nodes.
 */
export type OpenRecordKeys = ReadonlyMap<string, readonly string[]>;

/** The one spelling of the map's key, so both sides index it the same way. */
function recordIndex(integration: string, recordPath: string): string {
  return `${integration} ${recordPath}`;
}

/** Every key this graph fills an integration's records with. */
export function collectOpenRecordKeys(
  nodes: readonly WorkflowNode[],
  catalog: ExtensionCatalog
): OpenRecordKeys {
  const keysByRecord = new Map<string, string[]>();

  for (const node of nodes) {
    const actionType = readConfigString(node.data.config, "actionType");
    const action = actionType ? findAction(catalog, actionType) : undefined;
    const config = node.data.config;
    if (!(action?.integration && config)) {
      continue;
    }

    for (const field of flattenConfigFields(action.configFields)) {
      const names = filledKeys(config, field.key);
      if (names.length === 0) {
        continue;
      }

      for (const recordPath of field.fillsRecords ?? []) {
        const index = recordIndex(action.integration, recordPath);
        const existing = keysByRecord.get(index);
        if (existing) {
          existing.push(...names);
        } else {
          keysByRecord.set(index, [...names]);
        }
      }
    }
  }

  return new Map(
    Array.from(keysByRecord, ([index, names]) => [index, uniq(names)])
  );
}

/**
 * The names one node typed into one `key-value` field.
 *
 * A blank name is a row somebody is still filling in, and offering it as a path
 * would name nothing.
 */
function filledKeys(
  config: Record<string, unknown>,
  fieldKey: string
): string[] {
  const stored = readConfigString(config, fieldKey);
  const rows = stored ? readKeyValueRows(stored) : null;

  return (rows ?? [])
    .map((row) => row.name.trim())
    .filter((name) => name.length > 0);
}

/** The keys offered under one record, in the order the graph named them. */
export function keysForRecord(
  keys: OpenRecordKeys,
  integration: string | undefined,
  recordPath: string
): readonly string[] {
  return integration
    ? (keys.get(recordIndex(integration, recordPath)) ?? [])
    : [];
}
