---
name: oauth
description: >
  IntegrationOAuth: registerClient, authorize, exchange, refresh, revoke, PKCE
  S256, grantedAccessLabel, PublicOAuthClientMetadata, callExternalAsync token
  writes. Load when adding OAuth to defineIntegration. Host publicUrl and
  callback routes are wfgraph-core/embed, not this skill.
metadata:
  type: sub-skill
  library: wfgraph
  library_version: "3.1.1"
sources:
  - alandotcom/wfgraph:docs/integrations.md
  - alandotcom/wfgraph:docs/embedding.md
---

This skill builds on wfgraph-core/integrations/authoring. Host `publicUrl`,
callback `auth`, and Slack/Resend on/off: wfgraph-core/embed and wfgraph-plugins.

# Integration OAuth adapters

The integration owns the provider protocol. Core owns the browser flow,
encrypted grant storage, and refresh coordination. Do not reimplement attempts,
cookies, callback claiming, or refresh locking.

Assign the value to `oauth` on `defineIntegration`. The two complete forms are
compile-checked in `packages/plugins/src/integration-oauth-contract.test.ts`.

## Setup — registered confidential client

```ts
import type {
  IntegrationOAuth,
  OAuthGrant,
  OAuthRefreshInput,
  OAuthRevokeInput,
  OAuthTokenSet,
} from "@wfgraph/core/plugin";

export function registeredClientOAuth(
  registration: { readonly clientId: string; readonly clientSecret: string },
  provider: {
    readonly exchange: (input: {
      readonly clientId: string;
      readonly clientSecret: string;
      readonly code: string;
      readonly redirectUri: string;
    }) => Promise<OAuthGrant>;
    readonly refresh: (input: {
      readonly clientId: string;
      readonly clientSecret: string;
      readonly grant: OAuthGrant;
    }) => Promise<OAuthTokenSet>;
    readonly revoke: (input: {
      readonly clientId: string;
      readonly clientSecret: string;
      readonly grant: OAuthGrant;
    }) => Promise<void>;
  }
): IntegrationOAuth {
  return {
    label: "My Service",
    registerClient: () => registration,
    authorize: ({ client, redirectUri, state }) => {
      const url = new URL("https://auth.example.com/authorize");
      url.searchParams.set("client_id", client.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("state", state);
      return url;
    },
    async exchange({ client, code, redirectUri }) {
      const clientSecret = client.clientSecret;
      if (!clientSecret) {
        throw new Error("My Service OAuth client secret is not configured.");
      }
      return provider.exchange({
        clientId: client.clientId,
        clientSecret,
        code,
        redirectUri,
      });
    },
    async refresh({ client, grant }: OAuthRefreshInput) {
      const clientSecret = client.clientSecret;
      if (!clientSecret) {
        throw new Error("My Service OAuth client secret is not configured.");
      }
      return provider.refresh({
        clientId: client.clientId,
        clientSecret,
        grant,
      });
    },
    async revoke({ client, grant }: OAuthRevokeInput) {
      const clientSecret = client.clientSecret;
      if (!clientSecret) {
        throw new Error("My Service OAuth client secret is not configured.");
      }
      await provider.revoke({ clientId: client.clientId, clientSecret, grant });
    },
  } satisfies IntegrationOAuth;
}
```

Close over host-supplied client id/secret. The secret never enters the catalog
or public metadata.

## Core Patterns

### Public metadata client with PKCE

Set `pkce: "S256"`. Core generates the verifier and passes `codeChallenge` to
`authorize` and `codeVerifier` to `exchange`. `registerClient` returns
`clientId: context.metadataDocumentUrl` and a `metadataDocument` whose
`redirect_uris` is `[context.callbackUrl]` only. Unknown metadata fields fail
validation. Register every scope the integration could ever need.

### Grant mapping

`exchange` returns `OAuthGrant`. `refresh` returns `OAuthTokenSet`. Include
ISO 8601 `expiresAt` when the provider gives a lifetime. `credentials` keys
must be keys from the integration's `credentials` record. OAuth values override
matching manual values; handlers still read `bag.credentials.MY_KEY`.

Return `grantedAccessLabel` from both `exchange` and `refresh`, in the
provider's words, read off the token response.

### Token writes

POST through `callExternalAsync(callExternal(...))` with no idempotency key
and do not set `safeToRepeat`. Core serializes refresh for one connection.

### Tests

Pin registration, the full authorize URL, exact token HTTP, rotation, and
secret-free error messages in `[name]/oauth.test.ts`. Core tests own attempts
and fencing.

## Common Mistakes

### CRITICAL Retry refresh or set safeToRepeat on token POST

Wrong:

```ts
callExternal({ method: "POST", url: tokenUrl, safeToRepeat: true });
```

Correct: POST with no idempotency key; do not set `safeToRepeat`. Core holds
the refresh claim.

Source: alandotcom/wfgraph:docs/integrations.md (Core owns the browser flow)

### HIGH Put the client secret in metadataDocument

Wrong:

```ts
metadataDocument: { client_id, client_secret: registration.clientSecret };
```

Correct: public allowlist only (`client_id`, name, uri, redirect_uris, grants,
response_types, `token_endpoint_auth_method: "none"`, scope).

Source: alandotcom/wfgraph:docs/integrations.md (Client registration and public metadata)

### HIGH Invent PKCE in the adapter when pkce is unset

Wrong: require `codeChallenge` without `pkce: "S256"`.

Correct: with `pkce: "S256"` the types require challenge/verifier; without it
neither is passed. Do not cast them into existence.

Source: alandotcom/wfgraph:docs/integrations.md

### HIGH Assume granted scopes from the request

Wrong: `grantedAccessLabel: requestedScope`.

Correct: read the provider's token response; return that label on exchange and
refresh.

Source: alandotcom/wfgraph:docs/integrations.md (What the provider granted)

### MEDIUM Log the token response

Wrong: log `grant` or the raw token JSON.

Correct: never include codes, secrets, or tokens in messages or logs.

Source: alandotcom/wfgraph:docs/integrations.md
