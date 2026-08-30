/**
 * Integrations: their sealed config, refresh claims and OAuth attempts.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { createIntegrationCipher } from "#src/backend/services/integrations/cipher";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import type { WfGraphRepositories } from "#src/backend/runtime";
import type {
  ConformanceConnection,
  PersistenceTestRegistry,
} from "#src/backend/persistence/conformance/support";

export function describeIntegrationConformance({
  openConnection,
  openDatabase,
}: PersistenceTestRegistry): void {
  describe("integrations and OAuth", () => {
    it("inserts an integration under a caller-reserved id", async () => {
      const database = await openConnection();
      const inserted = await database.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          return yield* integrations.insertWithId({
            id: "int_reserved",
            name: "Reserved",
            type: "linear",
            config: { apiKey: "secret" },
          });
        })
      );

      expect(inserted).toMatchObject({
        id: "int_reserved",
        name: "Reserved",
        type: "linear",
        config: { apiKey: "secret" },
      });
    });

    it("implements the integration repository contract", async () => {
      const database = await openConnection();
      const result = await database.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          const inserted = yield* integrations.insert({
            name: "Primary",
            type: "linear",
            config: { apiKey: "secret" },
          });
          const updated = yield* integrations.update(inserted.id, {
            name: "Updated",
            config: { apiKey: "new-secret" },
            expectedRevision: inserted.configRevision,
          });
          return {
            inserted,
            updated,
            found: yield* integrations.findById(inserted.id),
            types: yield* integrations.typesByIds([inserted.id, "missing"]),
            listed: yield* integrations.listByType("linear"),
            deleteClaim: yield* integrations.claimRefresh({
              integrationId: inserted.id,
              claimId: "delete-claim",
              expectedRevision: 1,
            }),
            deleted: yield* integrations.deleteOwnedRefreshClaim({
              integrationId: inserted.id,
              claimId: "delete-claim",
              expectedRevision: 1,
            }),
            afterDelete: yield* integrations.findById(inserted.id),
          };
        })
      );

      expect(result.inserted.config).toEqual({ apiKey: "secret" });
      expect(result.updated).toMatchObject({
        status: "updated",
        integration: {
          name: "Updated",
          config: { apiKey: "new-secret" },
          configRevision: 1,
        },
      });
      expect(result.found?.config).toEqual({ apiKey: "new-secret" });
      expect(result.types).toEqual({ [result.inserted.id]: "linear" });
      expect(result.listed).toHaveLength(1);
      expect(result.deleteClaim).toEqual({ status: "acquired" });
      expect(result.deleted).toEqual({ status: "deleted" });
      expect(result.afterDelete).toBeNull();
    });

    it("does not delete a newer refresh owner when a stale claim is cleaned up", async () => {
      const database = await openConnection();
      const result = await database.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          const integration = yield* integrations.insert({
            name: "Refreshable",
            type: "linear",
            config: { accessToken: "original" },
          });
          const firstClaim = yield* integrations.claimRefresh({
            integrationId: integration.id,
            claimId: "old_claim",
            expectedRevision: 0,
          });
          const firstCompletion = yield* integrations.completeRefresh({
            integrationId: integration.id,
            claimId: "old_claim",
            expectedRevision: 0,
            config: { accessToken: "first" },
          });
          const secondClaim = yield* integrations.claimRefresh({
            integrationId: integration.id,
            claimId: "new_claim",
            expectedRevision: 1,
          });
          const staleDelete = yield* integrations.deleteOwnedRefreshClaim({
            integrationId: integration.id,
            claimId: "old_claim",
            expectedRevision: 0,
          });
          return {
            firstClaim,
            firstCompletion,
            secondClaim,
            staleDelete,
            integration: yield* integrations.findById(integration.id),
          };
        })
      );

      expect(result.firstClaim).toEqual({ status: "acquired" });
      expect(result.firstCompletion).toBe(true);
      expect(result.secondClaim).toEqual({ status: "acquired" });
      expect(result.staleDelete).toEqual({ status: "no_longer_owned" });
      expect(result.integration).toMatchObject({
        refreshState: "refreshing",
        refreshClaimId: "new_claim",
        configRevision: 1,
      });
    });

    it("claims OAuth attempts once, records durable outcomes, and enforces browser binding", async () => {
      const database = await openConnection();
      const result = await database.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          const integration = yield* integrations.insert({
            name: "OAuth connection",
            type: "linear",
            config: {},
          });
          const refreshClaim = yield* integrations.claimRefresh({
            integrationId: integration.id,
            claimId: "reconnect_state",
            expectedRevision: integration.configRevision,
          });
          yield* integrations.createOAuthAuthorizationAttempt({
            stateHash: "reconnect_state",
            integrationId: integration.id,
            expiresAt: new Date("2099-01-01T00:00:00Z"),
            browserBindingHash: "browser_hash",
            payload: {
              kind: "reconnect",
              redirectUri: "https://example.test/oauth/callback",
              configRevision: 0,
              codeVerifier: "valid_verifier",
            },
          });
          yield* integrations.createOAuthAuthorizationAttempt({
            stateHash: "wrong_browser_state",
            integrationId: integration.id,
            expiresAt: new Date("2099-01-01T00:00:00Z"),
            browserBindingHash: "browser_hash",
            payload: {
              kind: "reconnect",
              redirectUri: "https://example.test/oauth/callback",
              configRevision: 0,
            },
          });
          yield* integrations.createOAuthAuthorizationAttempt({
            stateHash: "create_state",
            integrationId: null,
            expiresAt: new Date("2099-01-01T00:00:00Z"),
            browserBindingHash: "browser_hash",
            payload: {
              kind: "create",
              integrationId: "int_reserved",
              name: "New OAuth connection",
              type: "linear",
              config: { MANUAL_TOKEN: "manual" },
              configRevision: 0,
              redirectUri: "https://example.test/oauth/callback",
              codeVerifier: "create_verifier",
            },
          });

          return {
            integrationId: integration.id,
            refreshClaim,
            reconnect: yield* integrations.claimOAuthAuthorizationAttempt({
              stateHash: "reconnect_state",
              browserBindingHash: "browser_hash",
              expiresAt: new Date("2099-01-01T00:10:00Z"),
            }),
            reconnectReplay: yield* integrations.claimOAuthAuthorizationAttempt(
              {
                stateHash: "reconnect_state",
                browserBindingHash: "browser_hash",
                expiresAt: new Date("2099-01-01T00:10:00Z"),
              }
            ),
            wrongBrowser: yield* integrations.claimOAuthAuthorizationAttempt({
              stateHash: "wrong_browser_state",
              browserBindingHash: "other_browser",
              expiresAt: new Date("2099-01-01T00:10:00Z"),
            }),
            wrongBrowserStatus:
              yield* integrations.readOAuthAuthorizationAttemptStatus({
                stateHash: "wrong_browser_state",
                browserBindingHash: "browser_hash",
              }),
            wrongBrowserBinding:
              yield* integrations.readOAuthAuthorizationAttemptStatus({
                stateHash: "wrong_browser_state",
                browserBindingHash: "other_browser",
              }),
            create: yield* integrations.claimOAuthAuthorizationAttempt({
              stateHash: "create_state",
              browserBindingHash: "browser_hash",
              expiresAt: new Date("2099-01-01T00:10:00Z"),
            }),
          };
        })
      );

      expect(result.refreshClaim).toEqual({ status: "acquired" });
      expect(result.reconnect).toEqual({
        integrationId: expect.any(String),
        payload: {
          kind: "reconnect",
          redirectUri: "https://example.test/oauth/callback",
          configRevision: 0,
          codeVerifier: "valid_verifier",
        },
      });
      expect(result.reconnectReplay).toBeNull();
      expect(result.wrongBrowser).toBeNull();
      expect(result.wrongBrowserStatus).toEqual({ status: "failed" });
      expect(result.wrongBrowserBinding).toBeNull();
      expect(result.create).toEqual({
        integrationId: null,
        payload: {
          kind: "create",
          integrationId: "int_reserved",
          name: "New OAuth connection",
          type: "linear",
          config: { MANUAL_TOKEN: "manual" },
          configRevision: 0,
          redirectUri: "https://example.test/oauth/callback",
          codeVerifier: "create_verifier",
        },
      });

      const reconnectIntegrationId = result.reconnect?.integrationId;
      if (!reconnectIntegrationId) {
        throw new Error("The reconnect attempt was not claimed");
      }

      const completed = await database.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          return {
            staleReconnect: yield* integrations.completeOAuthReconnectAttempt({
              stateHash: "reconnect_state",
              integrationId: reconnectIntegrationId,
              expectedRevision: 1,
              config: { accessToken: "stale" },
              expiresAt: new Date("2099-01-01T00:20:00Z"),
            }),
            reconnect: yield* integrations.completeOAuthReconnectAttempt({
              stateHash: "reconnect_state",
              integrationId: reconnectIntegrationId,
              expectedRevision: 0,
              config: { accessToken: "reconnected" },
              expiresAt: new Date("2099-01-01T00:20:00Z"),
            }),
            create: yield* integrations.completeOAuthCreateAttempt({
              stateHash: "create_state",
              integrationId: "int_reserved",
              name: "New OAuth connection",
              type: "linear",
              config: { accessToken: "created" },
              expiresAt: new Date("2099-01-01T00:20:00Z"),
            }),
            reconnectStatus:
              yield* integrations.readOAuthAuthorizationAttemptStatus({
                stateHash: "reconnect_state",
                browserBindingHash: "browser_hash",
              }),
            createStatus:
              yield* integrations.readOAuthAuthorizationAttemptStatus({
                stateHash: "create_state",
                browserBindingHash: "browser_hash",
              }),
            reconnectIntegration: yield* integrations.findById(
              result.integrationId
            ),
            createIntegration: yield* integrations.findById("int_reserved"),
          };
        })
      );

      expect(completed).toMatchObject({
        staleReconnect: false,
        reconnect: true,
        create: true,
        reconnectStatus: {
          status: "succeeded",
          integrationId: result.integrationId,
        },
        createStatus: { status: "succeeded", integrationId: "int_reserved" },
        reconnectIntegration: { config: { accessToken: "reconnected" } },
        createIntegration: { config: { accessToken: "created" } },
      });
    });

    it("fails processing attempts and retains terminal status until expiry", async () => {
      const database = await openConnection();
      const result = await database.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          yield* integrations.createOAuthAuthorizationAttempt({
            stateHash: "failed_state",
            integrationId: null,
            expiresAt: new Date("2099-01-01T00:00:00Z"),
            browserBindingHash: "browser_hash",
            payload: {
              kind: "create",
              integrationId: "int_failed",
              name: "Failed OAuth connection",
              type: "linear",
              config: {},
              configRevision: 0,
              redirectUri: "https://example.test/oauth/callback",
            },
          });
          const claimed = yield* integrations.claimOAuthAuthorizationAttempt({
            stateHash: "failed_state",
            browserBindingHash: "browser_hash",
            expiresAt: new Date("2099-01-01T00:10:00Z"),
          });
          const failed = yield* integrations.failOAuthAuthorizationAttempt({
            stateHash: "failed_state",
            expiresAt: new Date("2099-01-01T00:20:00Z"),
          });
          return {
            claimed,
            failed,
            status: yield* integrations.readOAuthAuthorizationAttemptStatus({
              stateHash: "failed_state",
              browserBindingHash: "browser_hash",
            }),
            replay: yield* integrations.claimOAuthAuthorizationAttempt({
              stateHash: "failed_state",
              browserBindingHash: "browser_hash",
              expiresAt: new Date("2099-01-01T00:30:00Z"),
            }),
          };
        })
      );

      expect(result.claimed).toMatchObject({ integrationId: null });
      expect(result.failed).toBe(true);
      expect(result.status).toEqual({ status: "failed" });
      expect(result.replay).toBeNull();
    });

    it("serializes competing refresh claims across connections", async () => {
      const store = await openDatabase();
      const database = await store.open();
      const otherConnection = await store.open();
      const integration = await database.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          return yield* integrations.insert({
            name: "Refreshable",
            type: "linear",
            config: {},
          });
        })
      );
      const claim = (connection: ConformanceConnection, claimId: string) =>
        connection.run(
          Effect.gen(function* () {
            const integrations = yield* IntegrationRepo;
            return yield* integrations.claimRefresh({
              integrationId: integration.id,
              claimId,
              expectedRevision: integration.configRevision,
            });
          })
        );

      const claims = await Promise.all([
        claim(database, "claim_1"),
        claim(otherConnection, "claim_2"),
      ]);
      const stored = await database.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          return yield* integrations.findById(integration.id);
        })
      );

      expect(claims.map((outcome) => outcome.status).toSorted()).toEqual([
        "acquired",
        "lost",
      ]);
      expect(stored).toMatchObject({
        refreshState: "refreshing",
        refreshClaimId: claims[0].status === "acquired" ? "claim_1" : "claim_2",
        refreshClaimedAt: expect.any(Date),
      });
    });

    it("fences refresh completion, release, and reauthorization transitions", async () => {
      const database = await openConnection();
      const result = await database.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          const integration = yield* integrations.insert({
            name: "Refreshable",
            type: "linear",
            config: { accessToken: "old" },
          });
          const acquired = yield* integrations.claimRefresh({
            integrationId: integration.id,
            claimId: "claim_1",
            expectedRevision: 0,
          });
          const competing = yield* integrations.claimRefresh({
            integrationId: integration.id,
            claimId: "claim_2",
            expectedRevision: 0,
          });
          const staleCompletion = yield* integrations.completeRefresh({
            integrationId: integration.id,
            claimId: "claim_2",
            expectedRevision: 0,
            config: { accessToken: "stale" },
          });
          const completed = yield* integrations.completeRefresh({
            integrationId: integration.id,
            claimId: "claim_1",
            expectedRevision: 0,
            config: { accessToken: "new" },
          });
          const afterCompletion = yield* integrations.findById(integration.id);

          yield* integrations.claimRefresh({
            integrationId: integration.id,
            claimId: "claim_3",
            expectedRevision: 1,
          });
          const staleRelease = yield* integrations.releaseRefreshClaim({
            integrationId: integration.id,
            claimId: "claim_1",
            expectedRevision: 1,
          });
          const staleReauthorization =
            yield* integrations.markReauthorizationRequired({
              integrationId: integration.id,
              claimId: "claim_1",
              expectedRevision: 1,
            });
          const released = yield* integrations.releaseRefreshClaim({
            integrationId: integration.id,
            claimId: "claim_3",
            expectedRevision: 1,
          });

          yield* integrations.claimRefresh({
            integrationId: integration.id,
            claimId: "claim_4",
            expectedRevision: 1,
          });
          const reauthorization =
            yield* integrations.markReauthorizationRequired({
              integrationId: integration.id,
              claimId: "claim_4",
              expectedRevision: 1,
            });
          const afterReauthorization = yield* integrations.findById(
            integration.id
          );
          const reconnectClaim = yield* integrations.claimRefresh({
            integrationId: integration.id,
            claimId: "reconnect_claim",
            expectedRevision: 1,
          });
          const reconnected = yield* integrations.completeRefresh({
            integrationId: integration.id,
            claimId: "reconnect_claim",
            expectedRevision: 1,
            config: { accessToken: "reconnected" },
          });
          const afterReconnect = yield* integrations.findById(integration.id);
          const missing = yield* integrations.claimRefresh({
            integrationId: "missing",
            claimId: "claim_5",
            expectedRevision: 0,
          });

          return {
            acquired,
            competing,
            staleCompletion,
            completed,
            afterCompletion,
            staleRelease,
            staleReauthorization,
            released,
            reauthorization,
            afterReauthorization,
            reconnectClaim,
            reconnected,
            afterReconnect,
            missing,
          };
        })
      );

      expect(result.acquired).toEqual({ status: "acquired" });
      expect(result.competing).toEqual({ status: "lost" });
      expect(result.staleCompletion).toBe(false);
      expect(result.completed).toBe(true);
      expect(result.afterCompletion).toMatchObject({
        config: { accessToken: "new" },
        configRevision: 1,
        refreshState: "idle",
        refreshClaimId: null,
        refreshClaimedAt: null,
      });
      expect(result.staleRelease).toBe(false);
      expect(result.staleReauthorization).toEqual({
        status: "no_longer_owned",
      });
      expect(result.released).toBe(true);
      expect(result.reauthorization).toEqual({ status: "transitioned" });
      expect(result.afterReauthorization).toMatchObject({
        refreshState: "reauthorization_required",
        refreshClaimId: null,
        refreshClaimedAt: null,
      });
      expect(result.reconnectClaim).toEqual({ status: "acquired" });
      expect(result.reconnected).toBe(true);
      expect(result.afterReconnect).toMatchObject({
        config: { accessToken: "reconnected" },
        configRevision: 2,
        refreshState: "idle",
        refreshClaimId: null,
        refreshClaimedAt: null,
      });
      expect(result.missing).toEqual({ status: "not_found" });
    });

    it("keeps an owned refresh authoritative over a racing manual config update", async () => {
      const database = await openConnection();
      const result = await database.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          const integration = yield* integrations.insert({
            name: "Refreshable",
            type: "linear",
            config: { accessToken: "old" },
          });
          yield* integrations.claimRefresh({
            integrationId: integration.id,
            claimId: "claim_1",
            expectedRevision: integration.configRevision,
          });
          const manual = yield* integrations.update(integration.id, {
            config: { accessToken: "manual" },
            expectedRevision: integration.configRevision,
          });
          const renamed = yield* integrations.update(integration.id, {
            name: "Renamed while refreshing",
          });
          const completed = yield* integrations.completeRefresh({
            integrationId: integration.id,
            claimId: "claim_1",
            expectedRevision: integration.configRevision,
            config: { accessToken: "refreshed" },
          });
          const afterRefresh = yield* integrations.findById(integration.id);
          if (!afterRefresh) throw new Error("Integration disappeared");
          const reconnectClaim = yield* integrations.claimRefresh({
            integrationId: integration.id,
            claimId: "reconnect_claim",
            expectedRevision: afterRefresh.configRevision,
          });
          const reconnected = yield* integrations.completeRefresh({
            integrationId: integration.id,
            claimId: "reconnect_claim",
            expectedRevision: afterRefresh.configRevision,
            config: { accessToken: "reconnected" },
          });
          const staleClaim = yield* integrations.claimRefresh({
            integrationId: integration.id,
            claimId: "stale_reader",
            expectedRevision: afterRefresh.configRevision,
          });

          return {
            manual,
            renamed,
            completed,
            afterRefresh,
            reconnectClaim,
            reconnected,
            staleClaim,
            stored: yield* integrations.findById(integration.id),
          };
        })
      );

      expect(result.manual).toEqual({ status: "conflict" });
      expect(result.renamed).toMatchObject({
        status: "updated",
        integration: { name: "Renamed while refreshing" },
      });
      expect(result.completed).toBe(true);
      expect(result.afterRefresh).toMatchObject({
        config: { accessToken: "refreshed" },
        configRevision: 1,
      });
      expect(result.reconnectClaim).toEqual({ status: "acquired" });
      expect(result.reconnected).toBe(true);
      expect(result.staleClaim).toEqual({ status: "lost" });
      expect(result.stored).toMatchObject({
        config: { accessToken: "reconnected" },
        configRevision: 2,
        refreshState: "idle",
      });
    });

    it("refuses every read of a row sealed under a key it no longer has", async () => {
      const store = await openDatabase();
      const sealed = await store.open();
      const integration = await sealed.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          return yield* integrations.insert({
            name: "Linear",
            type: "linear",
            config: { apiKey: "secret" },
          });
        })
      );
      await sealed.close();

      // A host that rotated INTEGRATION_ENCRYPTION_KEY without keeping the old
      // value. Both reads say so rather than answering an empty config, which
      // would read as a connection someone had cleared.
      const rotated = await store.open({
        cipher: createIntegrationCipher({ key: "d".repeat(64) }),
      });
      const readFailure = (
        effect: Effect.Effect<unknown, { _tag: string }, WfGraphRepositories>
      ) =>
        rotated.run(
          Effect.catch(effect, (failure) => Effect.succeed(failure._tag))
        );

      expect(
        await readFailure(
          Effect.gen(function* () {
            const integrations = yield* IntegrationRepo;
            return yield* integrations.listByType("linear");
          })
        )
      ).toBe("EncryptionKeyMismatch");
      expect(
        await readFailure(
          Effect.gen(function* () {
            const integrations = yield* IntegrationRepo;
            return yield* integrations.findById(integration.id);
          })
        )
      ).toBe("EncryptionKeyMismatch");

      // The row is still there; only its config is unreadable.
      expect(
        await rotated.run(
          Effect.gen(function* () {
            const integrations = yield* IntegrationRepo;
            return yield* integrations.typesByIds([integration.id]);
          })
        )
      ).toEqual({ [integration.id]: "linear" });
    });

    it("answers not_found when a refresh claim names an integration that is gone", async () => {
      const database = await openConnection();
      const result = await database.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          return {
            claim: yield* integrations.claimRefresh({
              integrationId: "int_missing",
              claimId: "claim_1",
              expectedRevision: 0,
            }),
            deletion: yield* integrations.deleteOwnedRefreshClaim({
              integrationId: "int_missing",
              claimId: "claim_1",
              expectedRevision: 0,
            }),
          };
        })
      );

      expect(result.claim).toEqual({ status: "not_found" });
      expect(result.deletion).toEqual({ status: "not_found" });
    });
  });
}
