/**
 * The sibling config values a provider-backed field's `optionsSource` named.
 *
 * Two callers ask this same question and must agree, or the editor judges a node
 * against an answer it would never have requested: the config panel asks the
 * connection what one open field can hold, and the issue collector asks it for
 * every node on the canvas. They shared a copy of this logic under two names
 * until the copies were merged here.
 *
 * An integration dependency is usable only once it has settled. A blank value
 * has not been chosen yet, and a value still holding a template token names an
 * upstream node whose output exists at run time rather than now, so either
 * leaves that integration query unasked. Host callbacks instead receive every
 * currently available literal and run with a partial draft.
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
 * The current raw literal strings a host option callback can inspect.
 *
 * Missing and non-string fields are absent. A template reference is absent too:
 * its value exists only when the workflow runs, so the editor cannot tell the
 * host callback what it will resolve to. Nonblank literal strings retain their
 * exact editor spelling.
 */
export function readActionOptionConfig(
  source: FieldOptionsSource | undefined,
  config: Record<string, unknown>
): Record<string, string> {
  return Object.fromEntries(
    (source?.parameters ?? []).flatMap((key): Array<[string, string]> => {
      const value = config[key];
      return typeof value === "string" &&
        value.trim().length > 0 &&
        findTemplateTokens(value).length === 0
        ? [[key, value]]
        : [];
    })
  );
}

/**
 * What an integration source can be asked with, and which of its declared
 * dependencies are not ready.
 *
 * A non-empty `missing` is the answer to "should this be asked at all": every
 * declared parameter has to have settled, because a provider handed a partial
 * set would answer about the wrong resource.
 */
export function readProviderParameters(
  source: FieldOptionsSource | undefined,
  config: Record<string, unknown>
): { parameters: Record<string, string>; missing: string[] } {
  const parameterEntries: Array<[string, string]> = [];
  const missing: string[] = [];

  for (const key of source?.parameters ?? []) {
    const value = settledProviderParameter(config[key]);
    if (value === undefined) {
      missing.push(key);
    } else {
      parameterEntries.push([key, value]);
    }
  }

  return { parameters: Object.fromEntries(parameterEntries), missing };
}
