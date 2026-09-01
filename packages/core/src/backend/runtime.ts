import { Layer, ManagedRuntime } from "effect";
import {
  AgentConfig,
  AgentCapacity,
  type AgentSettings,
  makeAgentConfigLayer,
} from "#src/backend/agent/config";
import { AppLogger, AppLoggerLayer } from "#src/backend/lib/effect/app-logger";
import {
  Extensions,
  makeExtensionsLayer,
} from "#src/backend/lib/effect/extensions";
import {
  InngestClient,
  makeInngestClientLayer,
} from "#src/backend/lib/effect/inngest-client";
import { TracerBridgeLayer } from "#src/backend/lib/effect/tracer";
import type { ExtensionSet } from "#src/backend/extensions/extension-set";
import type { InngestSurface } from "#src/backend/lib/inngest/client";
import { ApiKeyRepo } from "#src/backend/services/api-keys/repo";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { WorkflowRepo } from "#src/backend/services/workflows/repo/index";
import {
  makeAppContextLayer,
  WfGraphAppContext,
  type WfGraphAppContextValue,
} from "#src/backend/lib/effect/app-context";

/**
 * Everything a service may ask for.
 *
 * `Extensions` is the assembled surface, which a service reads for the
 * vocabulary its checks are made against. `Database` is deliberately absent. A
 * repository is the only thing allowed to run a query, and leaving `Database`
 * out of this union is what enforces that:
 * a service body that writes `yield* Database` puts `Database` in its own `R`,
 * which no longer matches the `R` this runtime satisfies, so the procedure that
 * runs it stops compiling.
 */
export type WfGraphServices =
  | AppLogger
  | AgentCapacity
  | AgentConfig
  | WfGraphAppContext
  | Extensions
  | ApiKeyRepo
  | IntegrationRepo
  | WorkflowRepo
  | ExecutionRepo
  | InngestClient;

/** The storage-facing services supplied by one persistence backend. */
export type WfGraphRepositories =
  | ApiKeyRepo
  | IntegrationRepo
  | WorkflowRepo
  | ExecutionRepo;

/** Everything the app hands the Layer graph, as the app itself holds it. */
export type WfGraphRuntimeParts = {
  inngest: InngestSurface;
  extensions: ExtensionSet;
  /** Stable host URLs used by request handlers and background credential refreshes. */
  appContext: WfGraphAppContextValue;
  /**
   * The build agent's model settings, or the off state. It carries a credential
   * and no per-request state, so it belongs on the runtime the way the Inngest
   * client does.
   */
  agent: AgentSettings;
  /** One backend's complete implementation of the repository contracts. */
  repositories: Layer.Layer<WfGraphRepositories>;
};

// A persistence backend composes the repository implementations. The runtime
// only sees their contracts, so neither its type nor its Layer graph names a
// database driver.
function buildWfGraphLayer(
  parts: WfGraphRuntimeParts
): Layer.Layer<WfGraphServices> {
  return Layer.mergeAll(
    AppLoggerLayer,
    // Provides no service: it replaces the Tracer every Effect span is opened on.
    TracerBridgeLayer,
    makeAppContextLayer(parts.appContext),
    makeExtensionsLayer(parts.extensions),
    makeAgentConfigLayer(parts.agent),
    parts.repositories,
    makeInngestClientLayer(parts.inngest.client)
  );
}

/**
 * The Layer graph, built once and owned by the app that created it.
 *
 * `createWfGraphApp` makes one of these and disposes it. Ownership is what buys the
 * dependency injection: a service reaches its repository and its logger through
 * this graph, so a test swaps either one by handing over a different Layer
 * instead of stubbing a module. Construction is lazy, and the graph is built on
 * the first Effect the runtime runs, so making an app opens no connections.
 *
 * One Workflow Graph per process stays the only supported arrangement (ADR-0002).
 */
export type WfGraphRuntime = ManagedRuntime.ManagedRuntime<
  WfGraphServices,
  never
>;

export function createWfGraphRuntime(
  parts: WfGraphRuntimeParts
): WfGraphRuntime {
  return ManagedRuntime.make(buildWfGraphLayer(parts));
}
