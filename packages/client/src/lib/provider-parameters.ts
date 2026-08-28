/**
 * The sibling config values a provider-backed field's `optionsSource` named.
 *
 * Two callers ask this same question and must agree, or the editor judges a node
 * against an answer it would never have requested: the config panel asks the
 * connection what one open field can hold, and the issue collector asks it for
 * every node on the canvas. They shared a copy of this logic under two names
 * until the copies were merged here.
 *
 * A parameter is usable only once it has settled. A blank value has not been
 * chosen yet, and a value still holding a template token names an upstream node
 * whose output exists at run time rather than now, so neither can be sent to a
 * provider. Both answer as absent, which is what leaves the query unasked.
 */

import { findTemplateTokens } from "@wfgraph/shared/graph/node-references";
import type { FieldOptionsSource } from "@wfgraph/shared/plugins/action-fields";

/** A value usable as a provider parameter: present, and not a node reference. */
export function settledProviderParameter(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || findTemplateTokens(trimmed).length > 0) {
    return undefined;
  }
  return trimmed;
}

/**
 * What a source can be asked with, and which of its parameters are not ready.
 *
 * A non-empty `missing` is the answer to "should this be asked at all": every
 * declared parameter has to have settled, because a provider handed a partial
 * set would answer about the wrong resource.
 */
export function readProviderParameters(
  source: FieldOptionsSource | undefined,
  config: Record<string, unknown>
): { parameters: Record<string, string>; missing: string[] } {
  const parameters: Record<string, string> = {};
  const missing: string[] = [];

  for (const key of source?.parameters ?? []) {
    const value = settledProviderParameter(config[key]);
    if (value === undefined) {
      missing.push(key);
    } else {
      parameters[key] = value;
    }
  }

  return { parameters, missing };
}
