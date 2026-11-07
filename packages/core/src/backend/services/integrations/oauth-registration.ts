import type { OAuthRegistrationContext } from "#src/backend/extensions/oauth";
import type { WfGraphAppContextValue } from "#src/backend/lib/effect/app-context";

export type OAuthUrls = {
  readonly callbackUrl: string;
  readonly metadataDocumentUrl: string;
};

/** Build the provider-facing URLs shared by routes and background refreshes. */
export function oauthUrlsFor(
  integrationType: string,
  context: Pick<WfGraphAppContextValue, "oauth">
): OAuthUrls | null {
  if (!context.oauth) {
    return null;
  }

  return {
    callbackUrl: context.oauth.callbackUrl,
    metadataDocumentUrl: context.oauth.metadataDocumentUrl(integrationType),
  };
}

export function oauthRegistrationContext(
  context: Pick<WfGraphAppContextValue, "oauth">,
  urls: OAuthUrls
): OAuthRegistrationContext {
  if (!context.oauth) {
    throw new Error("OAuth client registration requires a public URL");
  }
  return {
    publicUrl: context.oauth.publicUrl,
    callbackUrl: urls.callbackUrl,
    metadataDocumentUrl: urls.metadataDocumentUrl,
  };
}
