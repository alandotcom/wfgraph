/**
 * What the engine ships itself, as catalog entries: four actions and the database
 * connection one of them runs against.
 *
 * They belong here rather than in the browser because the catalog is the one
 * channel the editor learns the surface through: a built-in the browser knew
 * about on its own would be an action selector, or a connection form, that
 * disagrees with what the server can run.
 *
 * Each of the four actions is configured by a bespoke panel in the editor, written
 * against the shape that built-in has, which is why every `configFields` below is
 * empty: none of them renders through the declarative field list a plugin action
 * declares.
 *
 * `outputFields` states the shape each one always offers. Database Query and HTTP
 * Request also let a workflow declare a richer output schema on the node itself,
 * and the editor adds those fields to these.
 */

import {
  credentialFields,
  defineIntegration,
} from "#src/backend/lib/extensions/define-integration";
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

/**
 * The database a Database Query node runs against.
 *
 * An integration with no actions of its own: what it contributes is the
 * connection form, the key the step reads the URL by, and the probe behind "Test
 * connection". Database Query is the action, and it names this type the same way
 * a plugin action names its own integration, so the editor asks for a connection
 * on that node and nothing has to know which types are special.
 *
 * It is assembled with every host's integrations rather than passed by one,
 * because the action needing it is the engine's.
 */
export const databaseIntegration = defineIntegration({
  type: "database",
  label: "Database",
  description: "Connect to PostgreSQL databases",
  credentials: credentialFields([
    {
      label: "Database URL",
      type: "password",
      placeholder: "postgresql://user:password@host:port/database",
      configKey: "url",
      envVar: "DATABASE_URL",
      helpText:
        "Connection string in the format: postgresql://user:password@host:port/database",
    },
  ]),
  test: async () =>
    (await import("#src/backend/lib/extensions/database-test"))
      .testDatabaseConnection,
  actions: {},
});
