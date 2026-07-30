/**
 * What the engine ships itself, as catalog entries: Condition and Wait.
 *
 * They belong here rather than in the browser because the catalog is the one
 * channel the editor learns the surface through: a built-in the browser knew
 * about on its own would be an action selector that disagrees with what the
 * server can run.
 *
 * Both are the engine's own work rather than a `defineStep` value -- Condition
 * evaluates its expression during the traversal, Wait suspends the run -- so
 * they reach the editor as metadata and nothing dispatches to them. Each
 * `configFields` is empty because both are configured by a bespoke panel in
 * the editor, written against the shape each has, rather than through the
 * declarative field list a plugin action declares.
 */

import type { ActionMetadata } from "@rova/shared/extensions/catalog";

export const builtInActions: readonly ActionMetadata[] = [
  {
    id: "Condition",
    label: "Condition",
    description: "Branch based on a condition",
    category: "System",
    configFields: [],
    // The engine evaluates the expression and picks an outlet. Nothing
    // downstream reads a value from it, so there is no path to offer.
    outputFields: [],
  },
  {
    id: "Wait",
    label: "Wait",
    description: "Delay execution or wait for an Event",
    category: "System",
    configFields: [],
    outputFields: [],
  },
];
