import { Context, Layer } from "effect";

export type OAuthTopology = {
  readonly publicUrl: string;
  readonly apiBasePath: `/${string}`;
  readonly callbackUrl: string;
  readonly cookiePath: `/${string}`;
  readonly secureCookies: boolean;
  readonly metadataDocumentUrl: (integrationType: string) => string;
};

/** Stable host URLs that background services cannot derive from a request. */
export type WfGraphAppContextValue = {
  /** The normalized public origin. OAuth remains unavailable when it is absent. */
  readonly publicUrl?: string;
  /** The complete API mount path, such as `/wfgraph/api`. */
  readonly apiBasePath: `/${string}`;
  /** Every URL and cookie decision shared by the OAuth service and routes. */
  readonly oauth?: OAuthTopology;
};

export class WfGraphAppContext extends Context.Service<
  WfGraphAppContext,
  WfGraphAppContextValue
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
    ...(oauth ? { oauth } : {}),
  });
}
