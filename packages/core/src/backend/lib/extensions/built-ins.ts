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
 * Two of the four have a step: HTTP Request and Database Query are `defineStep`
 * values like any integration's action, so their config is decoded and their
 * payload encoded through their own schemas. The other two are the engine's own
 * work -- Condition evaluates its expression during the traversal, Wait suspends
 * the run -- so they reach the editor as metadata and nothing dispatches to them.
 *
 * Database Query's output fields are derived from its schema the way every other
 * action's are. HTTP Request writes its two out below, because `body` is
 * `Schema.Unknown`, which emits no `type` keyword: the derivation drops the
 * property and then refuses the whole list, since a list shorter than what the
 * step returns is worse than none. Annotating it puts no keyword back. The
 * `object` that hand-written entry gives `body` covers the common case; a
 * response with a non-JSON content type arrives as text, and a node that knows
 * its shape declares its own output schema, which the editor merges into the
 * paths it offers.
 *
 * `database-query.ts` imports `postgres` and `drizzle-orm` at module scope, so
 * both load with this module and therefore with the package. Both are core
 * dependencies already.
 */

import {
  credentialFields,
  defineIntegration,
} from "#src/backend/lib/extensions/define-integration";
import type { ActionStep } from "#src/backend/lib/steps/define-step";
import { databaseQueryStep } from "#src/backend/lib/steps/database-query";
import { httpRequestStep } from "#src/backend/lib/steps/http-request";
import type { ActionMetadata } from "@rova/shared/extensions/catalog";
import type { ReferenceField } from "@rova/shared/workflow/node-references";
import { requireOutputFieldsFromSchema } from "@rova/shared/workflow/output-fields";

/** A built-in that the engine dispatches to, in both halves the catalog needs. */
type BuiltInStepEntry = {
  readonly id: string;
  readonly step: ActionStep;
  /** Written out only where the output schema cannot describe itself. */
  readonly outputFields?: readonly ReferenceField[];
  /** The connection form the node asks for, where the action needs one. */
  readonly integration?: string;
};

export const builtInSteps: readonly BuiltInStepEntry[] = [
  {
    id: "HTTP Request",
    step: httpRequestStep,
    outputFields: [
      { path: "body", description: "Response body", type: "object" },
      { path: "status", description: "HTTP status code", type: "number" },
    ],
  },
  {
    id: "Database Query",
    step: databaseQueryStep,
    integration: "database",
  },
];

function toBuiltInActionMetadata(entry: BuiltInStepEntry): ActionMetadata {
  return {
    id: entry.id,
    label: entry.step.label,
    description: entry.step.description,
    category: entry.step.category,
    ...(entry.integration ? { integration: entry.integration } : {}),
    configFields: entry.step.configFields,
    outputFields:
      entry.outputFields ??
      requireOutputFieldsFromSchema(`Action "${entry.id}"`, entry.step.output),
  };
}

export const builtInActions: readonly ActionMetadata[] = [
  ...builtInSteps.map(toBuiltInActionMetadata),
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
