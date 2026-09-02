import { Effect } from "effect";
import type { ExtensionSet } from "#src/backend/extensions/extension-set";
import { makeAppContextLayer } from "#src/backend/lib/effect/app-context";
import {
  OAUTH_GRANT_CONFIG_KEY,
  serializeStoredOAuthGrant,
} from "#src/backend/services/integrations/oauth-grant";
import type { DecryptedIntegration } from "#src/backend/services/integrations/repo";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

export const appContext = makeAppContextLayer({
  publicUrl: "https://workflows.example.com",
  apiBasePath: "/api",
});

export const failedAttempt = Effect.succeed(true);

export function oauthExtensions(overrides: {
  registerClient?: (() => { clientId: string }) | undefined;
  exchange?: () => Promise<{
    credentials: Record<string, string>;
    tokens: {
      accessToken: string;
      refreshToken?: string | undefined;
      expiresAt?: string | undefined;
    };
    accountLabel?: string | undefined;
  }>;
  revoke: (accessToken: string) => Promise<void>;
}): Partial<ExtensionSet> {
  return {
    catalog: {
      ...emptyExtensionCatalog,
      integrations: [
        {
          type: "example",
          label: "Example",
          description: "Test integration",
          hasTest: false,
          hasWebhook: false,
          credentialFields: {
            ACCESS_TOKEN: { label: "Access token", type: "password" },
          },
        },
      ],
    },
    oauthFor: () => ({
      label: "Example OAuth",
      registerClient:
        overrides.registerClient ?? (() => ({ clientId: "example-client" })),
      authorize: () => new URL("https://provider.example/authorize"),
      exchange:
        overrides.exchange ??
        (async () => ({
          credentials: { ACCESS_TOKEN: "new-access" },
          tokens: { accessToken: "new-access" },
        })),
      refresh: async () => ({
        credentials: { ACCESS_TOKEN: "refreshed-access" },
        tokens: { accessToken: "refreshed-access" },
      }),
      revoke: async ({ grant }) => overrides.revoke(grant.tokens.accessToken),
    }),
  };
}

export function integrationWithGrant(
  accessToken: string,
  configRevision: number
): DecryptedIntegration {
  return {
    id: "int_1",
    name: "Example",
    type: "example",
    config: {
      [OAUTH_GRANT_CONFIG_KEY]: serializeStoredOAuthGrant({
        credentials: { ACCESS_TOKEN: accessToken },
        tokens: { accessToken },
        connectedAt: "2026-08-24T00:00:00.000Z",
      }),
    },
    configRevision,
    isManaged: false,
    refreshState: "idle",
    refreshClaimId: null,
    refreshClaimedAt: null,
    createdAt: new Date("2026-08-24T00:00:00.000Z"),
    updatedAt: new Date("2026-08-24T00:00:00.000Z"),
  };
}
