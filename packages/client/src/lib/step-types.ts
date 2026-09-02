/**
 * How the editor lists the node types a step can be, for both surfaces that
 * offer them: the config panel's action grid and the command palette.
 *
 * One module because the two must agree. They are the same question asked in
 * two places, and a copy of the grouping in each is how "delay" came to find
 * Wait in one of them and nothing in the other.
 */

import { compact, groupBy } from "es-toolkit/array";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import type { ActionMetadata } from "@wfgraph/shared/extensions/catalog";
import { compareText } from "@wfgraph/shared/types/string";

/**
 * Words a node type answers to besides its own name.
 *
 * Someone reaching for a pause types "delay", and someone reaching for a fork
 * types "branch"; neither word appears in the label or the description of the
 * step they want. Only the three steps the engine ships need this, because a
 * host's or a plugin's action is named by whoever wrote it and its integration
 * name is already searched.
 */
const STEP_SYNONYMS: Record<string, readonly string[]> = {
  [BUILT_IN_ACTION_IDS.condition]: [
    "branch",
    "if",
    "else",
    "filter",
    "decision",
    "route",
  ],
  [BUILT_IN_ACTION_IDS.wait]: [
    "delay",
    "sleep",
    "pause",
    "timer",
    "schedule",
    "later",
  ],
  [BUILT_IN_ACTION_IDS.eventSplit]: [
    "fan out",
    "race",
    "whichever",
    "first event",
    "branch on event",
  ],
};

/**
 * Everything a node type can be found by, as one string.
 *
 * The palette hands this to Base UI as `itemToStringValue`, which is what its
 * filter matches the query against; the action grid tests it with `includes`.
 * Both lowercase it themselves, so this keeps the labels as written.
 */
export function stepSearchText(action: ActionMetadata): string {
  return compact([
    action.label,
    action.category,
    action.integration,
    action.description,
    ...(STEP_SYNONYMS[action.id] ?? []),
  ]).join(" ");
}

/** Whether a node type answers to `query`. An empty query matches everything. */
export function stepMatchesQuery(
  action: ActionMetadata,
  query: string
): boolean {
  return stepSearchText(action).toLowerCase().includes(query.toLowerCase());
}

/**
 * The node types grouped for display, System first and the rest by name.
 *
 * System leads because the three steps the engine ships are the ones every
 * workflow reaches for; everything after it is a host's or a plugin's, and
 * alphabetical is the only order this side knows about.
 */
export function stepGroups(
  actions: readonly ActionMetadata[]
): { category: string; actions: ActionMetadata[] }[] {
  // Key order matches the order categories first appear in `actions`, the
  // same guarantee the previous Map-based loop gave.
  const byCategory = groupBy(actions, (action) => action.category);

  return Object.keys(byCategory)
    .toSorted((a, b) => {
      if (a === "System") {
        return -1;
      }
      if (b === "System") {
        return 1;
      }
      return compareText(a, b);
    })
    .map((category) => ({
      category,
      actions: byCategory[category] ?? [],
    }));
}
