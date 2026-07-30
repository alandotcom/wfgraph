/**
 * The four actions the engine ships itself, as catalog entries.
 *
 * They belong here rather than in the browser because the catalog is the one
 * channel the editor learns the surface through: a built-in the browser knew
 * about on its own would be an action selector that disagrees with what the
 * server can run.
 *
 * Each of the four is configured by a bespoke panel in the editor, written
 * against the shape that built-in has, which is why every `configFields` below is
 * empty: none of them renders through the declarative field list a plugin action
 * declares.
 *
 * `outputFields` states the shape each one always offers. Database Query and HTTP
 * Request also let a workflow declare a richer output schema on the node itself,
 * and the editor adds those fields to these.
 */

import type { ActionMetadata } from "@rova/shared/extensions/catalog";

export const builtInActions: readonly ActionMetadata[] = [
  {
    id: "HTTP Request",
    label: "HTTP Request",
    description: "Make an HTTP request to any API",
    category: "System",
    configFields: [],
    outputFields: [
      { path: "data", description: "Response data", type: "object" },
      { path: "status", description: "HTTP status code", type: "number" },
    ],
  },
  {
    id: "Database Query",
    label: "Database Query",
    description: "Query your database",
    category: "System",
    integration: "database",
    configFields: [],
    outputFields: [
      { path: "rows", description: "Query result rows", type: "array" },
      { path: "count", description: "Number of rows", type: "number" },
    ],
  },
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
