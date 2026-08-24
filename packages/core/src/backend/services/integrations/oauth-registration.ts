import type { OAuthRegistrationContext } from "#src/backend/extensions/oauth";
import type { WfGraphAppContextValue } from "#src/backend/lib/effect/app-context";

export type OAuthUrls = {
  readonly callbackUrl: string;
  readonly metadataDocumentUrl: string;
};

/** Build the provider-facing URLs shared by routes and background refreshes. */
export function oauthUrlsFor(
  integrationType: string,
  context: WfGraphAppContextValue
): OAuthUrls | null {
  if (!context.publicUrl) {
    return null;
  }

  const apiUrl = `${context.publicUrl}${context.apiBasePath}`;
  return {
    callbackUrl: `${apiUrl}/integrations/oauth/callback`,
    metadataDocumentUrl: `${apiUrl}/integrations/oauth/clients/${encodeURIComponent(integrationType)}`,
  };
}

export function oauthRegistrationContext(
  context: WfGraphAppContextValue,
  urls: OAuthUrls
): OAuthRegistrationContext {
  if (!context.publicUrl) {
    throw new Error("OAuth client registration requires a public URL");
  }
  return {
    publicUrl: context.publicUrl,
    callbackUrl: urls.callbackUrl,
    metadataDocumentUrl: urls.metadataDocumentUrl,
  };
}
