import { Context, Effect, Layer } from "effect";
// Aliased on the way in: the service file above exports `getIntegration`,
// `getIntegrations` and `deleteIntegration` too, and those are the domain
// operations. These are the rows underneath them.
import {
  createIntegration,
  type DecryptedIntegration,
  deleteIntegration as deleteIntegrationRow,
  getIntegration as getIntegrationRow,
  getIntegrations as listIntegrationRows,
  updateIntegration,
} from "#src/backend/lib/db/integrations";
import {
  callDbModule,
  type DatabaseError,
} from "#src/backend/lib/effect/database";
import type {
  IntegrationConfig,
  IntegrationType,
} from "@rova/shared/types/integration";

/**
 * Every database question the integration services ask.
 *
 * The domain code above it never names a table, a column, or the encryption that
 * wraps a stored config, which is what lets a test answer these directly instead
 * of standing up a database and a key. A query failure arrives as a typed
 * `DatabaseError` rather than a rejected promise, the way ADR-0005 describes.
 */
export class IntegrationRepo extends Context.Service<
  IntegrationRepo,
  {
    /** Every integration, or only those of one type. */
    readonly listByType: (
      type?: IntegrationType
    ) => Effect.Effect<DecryptedIntegration[], DatabaseError>;
    readonly findById: (
      integrationId: string
    ) => Effect.Effect<DecryptedIntegration | null, DatabaseError>;
    readonly insert: (input: {
      name: string;
      type: IntegrationType;
      config: IntegrationConfig;
    }) => Effect.Effect<DecryptedIntegration, DatabaseError>;
    /** Null when the row was gone by the time the update ran. */
    readonly update: (
      integrationId: string,
      updates: { name?: string; config?: IntegrationConfig }
    ) => Effect.Effect<DecryptedIntegration | null, DatabaseError>;
    /** Whether a row was actually removed. */
    readonly deleteById: (
      integrationId: string
    ) => Effect.Effect<boolean, DatabaseError>;
  }
>()("IntegrationRepo") {}

/**
 * The live repository.
 *
 * Unlike the API key repository, these methods delegate to
 * `backend/lib/db/integrations` rather than writing Drizzle inline, because that
 * module also owns the AES envelope every config passes through on its way in
 * and out, and `workflow-integration-validation.ts` still reads from it. Since
 * that module holds its own handle, this layer takes no `Database` service:
 * `callDbModule` supplies the one thing the delegation still needs, which is the
 * typed error channel. What the seam buys is that channel and a place for a test
 * to stand, rather than the query builder.
 *
 * Stage 7 is what changes this: `backend/lib/db/integrations.ts` has to run its
 * queries on the handle the Layer owns before `getDb` can be deleted, and these
 * methods go back to `database.query` when it does. It waits that long because
 * the run engine reads the same module for a step's credentials, from outside
 * any runtime.
 *
 * Delegating also means an encryption failure arrives as a `DatabaseError`,
 * which is the mapping the pre-Effect code had: both a refused query and an
 * unreadable ciphertext were caught by the same `try` and reported as
 * "internal".
 */
export const IntegrationRepoLayer: Layer.Layer<IntegrationRepo> = Layer.succeed(
  IntegrationRepo,
  {
    listByType: (type) => callDbModule(() => listIntegrationRows(type)),

    findById: (integrationId) =>
      callDbModule(() => getIntegrationRow(integrationId)),

    insert: (input) =>
      callDbModule(() =>
        createIntegration(input.name, input.type, input.config)
      ),

    update: (integrationId, updates) =>
      callDbModule(() => updateIntegration(integrationId, updates)),

    deleteById: (integrationId) =>
      callDbModule(() => deleteIntegrationRow(integrationId)),
  }
);
