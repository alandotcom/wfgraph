import { Schema } from "effect";
import {
  NonEmptyTrimmedString,
  rejectUnknownKeys,
} from "@wfgraph/shared/types/schema";

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
  readonly metadataDocument?: PublicOAuthClientMetadata;
};

/** The deliberately small, public-only client metadata surface core can serve. */
export const publicOAuthClientMetadataSchema = Schema.Struct({
  client_id: NonEmptyTrimmedString,
  client_name: Schema.optionalKey(NonEmptyTrimmedString),
  client_uri: Schema.optionalKey(NonEmptyTrimmedString),
  redirect_uris: Schema.optionalKey(Schema.Array(NonEmptyTrimmedString)),
  grant_types: Schema.optionalKey(
    Schema.Array(Schema.Literals(["authorization_code", "refresh_token"]))
  ),
  response_types: Schema.optionalKey(Schema.Array(Schema.Literal("code"))),
  token_endpoint_auth_method: Schema.optionalKey(Schema.Literal("none")),
  scope: Schema.optionalKey(NonEmptyTrimmedString),
});

export type PublicOAuthClientMetadata =
  typeof publicOAuthClientMetadataSchema.Type;

export const decodePublicOAuthClientMetadata = Schema.decodeUnknownResult(
  publicOAuthClientMetadataSchema,
  rejectUnknownKeys
);

export type OAuthAuthorizationInput = {
  readonly client: OAuthClientRegistration;
  readonly redirectUri: string;
  readonly state: string;
};

export type OAuthExchangeInput = {
  readonly client: OAuthClientRegistration;
  readonly code: string;
  readonly redirectUri: string;
};

export type OAuthPkceAuthorizationInput = OAuthAuthorizationInput & {
  readonly codeChallenge: string;
};

export type OAuthPkceExchangeInput = OAuthExchangeInput & {
  readonly codeVerifier: string;
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
type IntegrationOAuthBase = {
  /** Browser copy for the connection action. This is the only catalog field. */
  readonly label: string;
  readonly registerClient: (
    context: OAuthRegistrationContext
  ) => OAuthClientRegistration;
  readonly refresh: (input: OAuthRefreshInput) => Promise<OAuthTokenSet>;
  readonly revoke: (input: OAuthRevokeInput) => Promise<void>;
};

export type IntegrationOAuth =
  | (IntegrationOAuthBase & {
      readonly pkce: "S256";
      readonly authorize: (input: OAuthPkceAuthorizationInput) => URL;
      readonly exchange: (input: OAuthPkceExchangeInput) => Promise<OAuthGrant>;
    })
  | (IntegrationOAuthBase & {
      readonly pkce?: undefined;
      readonly authorize: (input: OAuthAuthorizationInput) => URL;
      readonly exchange: (input: OAuthExchangeInput) => Promise<OAuthGrant>;
    });
