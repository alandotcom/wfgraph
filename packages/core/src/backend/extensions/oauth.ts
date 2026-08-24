import type { JsonObject } from "@wfgraph/shared/types/json";

/** Stable URLs core derives from the host's public origin for one integration. */
export type OAuthRegistrationContext = {
  readonly publicUrl: string;
  readonly callbackUrl: string;
  readonly metadataDocumentUrl: string;
};

/** The client identity an integration supplies to its OAuth provider. */
export type OAuthClientRegistration = {
  readonly clientId: string;
  readonly clientSecret?: string;
  /** Present for providers that discover clients through a metadata document. */
  readonly metadataDocument?: JsonObject;
};

export type OAuthAuthorizationInput = {
  readonly client: OAuthClientRegistration;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge?: string;
};

export type OAuthExchangeInput = {
  readonly client: OAuthClientRegistration;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier?: string;
};

/** Tokens that must be replaced together after an exchange or refresh. */
export type OAuthTokens = {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** An ISO 8601 timestamp. Absent means the access token has no known expiry. */
  readonly expiresAt?: string;
};

/**
 * The provider result core encrypts as one unit.
 *
 * `credentials` maps the access grant into the integration's declared credential
 * vocabulary. Core validates those keys before making them available to actions.
 */
export type OAuthTokenSet = {
  readonly credentials: Readonly<Record<string, string>>;
  readonly tokens: OAuthTokens;
};

export type OAuthGrant = OAuthTokenSet & {
  readonly accountLabel?: string;
};

export type OAuthRefreshInput = {
  readonly client: OAuthClientRegistration;
  readonly grant: OAuthGrant;
};

export type OAuthRevokeInput = {
  readonly client: OAuthClientRegistration;
  readonly grant: OAuthGrant;
};

/**
 * Provider-owned OAuth behavior. Core supplies routing and transaction context;
 * the integration owns every provider endpoint and wire format.
 */
export type IntegrationOAuth = {
  /** Browser copy for the connection action. This is the only catalog field. */
  readonly label: string;
  /** Requests S256 PKCE generation and verification from core. */
  readonly pkce?: "S256";
  readonly registerClient: (
    context: OAuthRegistrationContext
  ) => OAuthClientRegistration;
  readonly authorize: (input: OAuthAuthorizationInput) => URL;
  readonly exchange: (input: OAuthExchangeInput) => Promise<OAuthGrant>;
  readonly refresh: (input: OAuthRefreshInput) => Promise<OAuthTokenSet>;
  readonly revoke: (input: OAuthRevokeInput) => Promise<void>;
};
