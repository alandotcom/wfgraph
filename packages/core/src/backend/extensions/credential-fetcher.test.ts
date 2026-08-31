import { Effect, Result } from "effect";
import { describe, expect, it } from "vitest";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import {
  CredentialsUnavailable,
  fetchCredentials,
} from "#src/backend/extensions/credential-fetcher";
import { DatabaseError } from "#src/backend/lib/effect/database";
import {
  ENCRYPTION_KEY_MISMATCH_MESSAGE,
  EncryptionKeyMismatch,
} from "#src/backend/services/integrations/cipher";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";
import {
  OAUTH_GRANT_CONFIG_KEY,
  serializeStoredOAuthGrant,
} from "#src/backend/services/integrations/oauth-grant";

/**
 * What the credential read answers with, which decides whether the step that
 * asked for it is retried.
 *
 * The read reaches a repository, and a repository fails typed, so the failure
 * has to survive the crossing into a step's Effect as a value rather than as a
 * defect: a defect leaves by the throw path, where nothing can tell a database
 * that was briefly unreachable from a run that went wrong.
 */
describe("fetchCredentials", () => {
  it("answers a database refusal as a typed failure naming the integration", async () => {
    const runtime = stubWfGraphRuntime({
      integrationRepo: {
        findById: () =>
          Effect.fail(new DatabaseError({ cause: new Error("no connection") })),
      },
    });

    const outcome = await runtime.runPromise(
      Effect.result(fetchCredentials(runtime, "int_missing"))
    );

    expect(Result.isFailure(outcome)).toBe(true);
    expect(outcome).toMatchObject({
      failure: {
        _tag: "CredentialsUnavailable",
        integrationId: "int_missing",
      },
    });
    if (Result.isFailure(outcome)) {
      expect(outcome.failure.message).toBe(
        'Could not read the credentials for integration "int_missing".'
      );
    }
    expect(JSON.stringify(outcome)).not.toContain("no connection");
  });

  // Both failures reach the step as `CredentialsUnavailable`, so the message is
  // the only thing a reader can tell them apart by.
  it("names the key when the stored row was sealed under another one", async () => {
    const runtime = stubWfGraphRuntime({
      integrationRepo: {
        findById: () =>
          Effect.fail(
            new EncryptionKeyMismatch({ cause: new Error("bad auth tag") })
          ),
      },
    });

    const outcome = await runtime.runPromise(
      Effect.result(fetchCredentials(runtime, "int_1"))
    );

    expect(outcome).toMatchObject({
      failure: {
        _tag: "CredentialsUnavailable",
        integrationId: "int_1",
        message: ENCRYPTION_KEY_MISMATCH_MESSAGE,
      },
    });
  });

  it("answers a missing integration as unavailable", async () => {
    const runtime = stubWfGraphRuntime({
      integrationRepo: { findById: () => Effect.succeed(null) },
    });

    const outcome = await runtime.runPromise(
      Effect.result(fetchCredentials(runtime, "int_gone"))
    );

    expect(outcome).toMatchObject({
      failure: {
        _tag: "CredentialsUnavailable",
        integrationId: "int_gone",
      },
    });
  });

  it("uses OAuth credential overrides ahead of manual configuration", async () => {
    const catalog = {
      ...emptyExtensionCatalog,
      integrations: [
        {
          type: "example",
          label: "Example",
          description: "test integration",
          hasTest: false,
          hasWebhook: false,
          credentialFields: {
            ACCESS_TOKEN: { label: "Access token", type: "password" as const },
          },
        },
      ],
    };
    const runtime = stubWfGraphRuntime({
      extensions: { catalog },
      integrationRepo: {
        findById: () =>
          Effect.succeed({
            id: "int_1",
            name: "Example",
            type: "example",
            config: {
              ACCESS_TOKEN: "manual-token",
              [OAUTH_GRANT_CONFIG_KEY]: serializeStoredOAuthGrant({
                credentials: { ACCESS_TOKEN: "oauth-token" },
                tokens: { accessToken: "oauth-token" },
                connectedAt: "2026-08-24T00:00:00.000Z",
              }),
            },
            configRevision: 0,
            isManaged: false,
            refreshState: "idle" as const,
            refreshClaimId: null,
            refreshClaimedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
      },
    });
    const credentials = await runtime.runPromise(
      fetchCredentials(runtime, "int_1")
    );

    expect(credentials).toEqual({ ACCESS_TOKEN: "oauth-token" });
  });

  it("refuses a damaged reserved OAuth grant instead of using manual credentials", async () => {
    const runtime = stubWfGraphRuntime({
      integrationRepo: {
        findById: () =>
          Effect.succeed({
            id: "int_1",
            name: "Example",
            type: "example",
            config: {
              ACCESS_TOKEN: "manual-token",
              [OAUTH_GRANT_CONFIG_KEY]: "{damaged",
            },
            configRevision: 0,
            isManaged: false,
            refreshState: "idle" as const,
            refreshClaimId: null,
            refreshClaimedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
      },
      extensions: {
        catalog: {
          ...emptyExtensionCatalog,
          integrations: [
            {
              type: "example",
              label: "Example",
              description: "test integration",
              hasTest: false,
              hasWebhook: false,
              credentialFields: {
                ACCESS_TOKEN: {
                  label: "Access token",
                  type: "password" as const,
                },
              },
            },
          ],
        },
      },
    });

    const outcome = await runtime.runPromise(
      Effect.result(fetchCredentials(runtime, "int_1"))
    );

    expect(outcome).toMatchObject({
      failure: {
        _tag: "CredentialsUnavailable",
        integrationId: "int_1",
      },
    });
  });
});

// The class is what a plugin annotates a credential-reading helper with, so the
// tag it carries is part of the published surface rather than an internal.
it("carries its message on the error it is", () => {
  const failure = new CredentialsUnavailable({
    integrationId: "int_1",
    message: "Could not read them.",
  });

  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).toBe("Could not read them.");
});
