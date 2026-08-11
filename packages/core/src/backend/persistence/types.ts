import type { Layer } from "effect";
import type { IntegrationCipher } from "#src/backend/services/integrations/cipher";
import type { WfGraphRepositories } from "#src/backend/runtime";

/** The resources one persistence backend gives to an app instance. */
export type WfGraphPersistenceInstance = {
  readonly repositories: Layer.Layer<WfGraphRepositories>;
  readonly description: Readonly<Record<string, string | number | boolean>>;
  readonly close: () => Promise<void>;
};

/**
 * An opaque persistence backend selected by the host.
 *
 * Core asks it for repository implementations and knows nothing about its
 * driver, schema, migrations, or connection lifetime.
 */
export type WfGraphPersistence = {
  readonly open: (
    cipher: IntegrationCipher
  ) => Promise<WfGraphPersistenceInstance>;
};
