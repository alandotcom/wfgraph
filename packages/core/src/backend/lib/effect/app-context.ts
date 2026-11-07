import { Context, Layer } from "effect";

export type OAuthTopology = {
  readonly publicUrl: string;
  readonly apiBasePath: `/${string}`;
  readonly callbackUrl: string;
  readonly cookiePath: `/${string}`;
  readonly secureCookies: boolean;
  readonly metadataDocumentUrl: (integrationType: string) => string;
};

/**
 * How long a due run may wait for a worker before the Runs view says no worker
 * has claimed it, for a host that names no value of its own: a minute, which
 * is what a worker loop at its default poll gives.
 */
export const DEFAULT_OVERDUE_AFTER_MS = 60_000;

/**
 * Stable host facts that background services cannot derive from a request:
 * its URLs, how often its workers look for due runs, and how long it keeps run
 * history.
 */
export type WfGraphAppContextValue = {
  /** The normalized public origin. OAuth remains unavailable when it is absent. */
  readonly publicUrl?: string | undefined;
  /** The complete API mount path, such as `/wfgraph/api`. */
  readonly apiBasePath: `/${string}`;
  /** Every URL and cookie decision shared by the OAuth service and routes. */
  readonly oauth?: OAuthTopology | undefined;
  /**
   * How long a due run may wait for a worker on this host before the Runs
   * view says no worker has claimed it (`overdueAfterMs` in
   * `services/executions/executor-state.ts`). `DEFAULT_OVERDUE_AFTER_MS` when
   * left out.
   */
  readonly overdueAfterMs?: number | undefined;
  /**
   * The host's `runs.retentionMs`, which the Runs view states so a builder
   * knows why old runs are gone. Left out when the host keeps every run.
   */
  readonly runRetentionMs?: number | undefined;
};

export class WfGraphAppContext extends Context.Service<
  WfGraphAppContext,
  Omit<WfGraphAppContextValue, "runRetentionMs"> & {
    readonly overdueAfterMs: number;
    /** The host's `runs.retentionMs`, or null when it keeps every run. */
    readonly runRetentionMs: number | null;
  }
>()("@wfgraph/core/WfGraphAppContext") {}

export function makeAppContextLayer(
  value: WfGraphAppContextValue
): Layer.Layer<WfGraphAppContext> {
  const oauth = value.publicUrl
    ? {
        publicUrl: value.publicUrl,
        apiBasePath: value.apiBasePath,
        callbackUrl: `${value.publicUrl}${value.apiBasePath}/integrations/oauth/callback`,
        cookiePath: `${value.apiBasePath}/integrations/oauth` as const,
        secureCookies: value.publicUrl.startsWith("https://"),
        metadataDocumentUrl: (integrationType: string) =>
          `${value.publicUrl}${value.apiBasePath}/integrations/oauth/clients/${encodeURIComponent(integrationType)}`,
      }
    : undefined;

  return Layer.succeed(WfGraphAppContext, {
    ...value,
    oauth,
    overdueAfterMs: value.overdueAfterMs ?? DEFAULT_OVERDUE_AFTER_MS,
    runRetentionMs: value.runRetentionMs ?? null,
  });
}
