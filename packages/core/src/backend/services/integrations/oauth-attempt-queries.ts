/**
 * The `oauth_authorization_attempts` half of `IntegrationRepo`.
 *
 * These are separated from the integration row's own queries for size and for
 * reading order, and deliberately not into a second repository service. Three of
 * them write the `integrations` table inside the same transaction that moves the
 * attempt: the reaper fences a connection whose reconnect expired mid-flight, a
 * create inserts the row and marks the attempt succeeded, and a reconnect
 * replaces the config and marks the attempt succeeded. That atomicity is the
 * property the whole flow rests on, so the two tables answer to one service and
 * one transaction boundary, and only the implementation is split.
 *
 * Everything here is one method of `IntegrationRepo`. The service, its contract
 * and its layer stay in `repo.ts`, which composes what this returns.
 */

import { and, eq, gt, inArray, lte, ne, sql } from "drizzle-orm";
import { Effect } from "effect";
import {
  integrations,
  oauthAuthorizationAttempts,
} from "#src/backend/lib/db/schema";
import type { Database } from "#src/backend/lib/effect/database";
import type {
  EncryptionKeyMismatch,
  IntegrationCipher,
} from "#src/backend/services/integrations/cipher";
import {
  type ClaimedOAuthAuthorizationAttempt,
  type IntegrationRepo,
  readOAuthAuthorizationAttemptPayload,
} from "#src/backend/services/integrations/repo";

/**
 * The subset of the repository this module supplies.
 *
 * Naming it off the service is what types every `input` below: the contract is
 * declared once, on `IntegrationRepo`, and these are its implementations rather
 * than a second surface that could drift from it.
 */
export type OAuthAttemptQueries = Pick<
  IntegrationRepo["Service"],
  | "createOAuthAuthorizationAttempt"
  | "claimOAuthAuthorizationAttempt"
  | "readOAuthAuthorizationAttemptStatus"
  | "failOAuthAuthorizationAttempt"
  | "completeOAuthCreateAttempt"
  | "completeOAuthReconnectAttempt"
>;

/** The attempt-lifecycle methods, bound to the connection and cipher in use. */
export function makeOAuthAttemptQueries(
  database: Database["Service"],
  cipher: IntegrationCipher
): OAuthAttemptQueries {
  const claimedAttempt = (
    attempt: {
      integrationId: string | null;
      encryptedPayload: string;
    } | null
  ): Effect.Effect<
    ClaimedOAuthAuthorizationAttempt | null,
    EncryptionKeyMismatch
  > => {
    if (!attempt) return Effect.succeed(null);
    return cipher.open(attempt.encryptedPayload).pipe(
      Effect.map((config) => {
        const payload = readOAuthAuthorizationAttemptPayload(config);
        if (!payload) return null;
        if (payload.kind === "create") {
          return attempt.integrationId === null
            ? { integrationId: null, payload }
            : null;
        }
        return attempt.integrationId === null
          ? null
          : { integrationId: attempt.integrationId, payload };
      })
    );
  };

  return {
    createOAuthAuthorizationAttempt: (input) =>
      database.query((db) =>
        db.transaction(async (tx) => {
          const now = new Date();
          const expired = await tx
            .select({
              stateHash: oauthAuthorizationAttempts.stateHash,
              mode: oauthAuthorizationAttempts.mode,
              status: oauthAuthorizationAttempts.status,
            })
            .from(oauthAuthorizationAttempts)
            .where(lte(oauthAuthorizationAttempts.expiresAt, now))
            .for("update");
          const expiredStateHashes = expired.map(
            (attempt) => attempt.stateHash
          );
          const expiredProcessingReconnectStateHashes = expired
            .filter(
              (attempt) =>
                attempt.mode === "reconnect" && attempt.status === "processing"
            )
            .map((attempt) => attempt.stateHash);

          if (expiredProcessingReconnectStateHashes.length > 0) {
            await tx
              .update(integrations)
              .set({
                refreshState: "reauthorization_required",
                refreshClaimId: null,
                refreshClaimedAt: null,
                updatedAt: now,
              })
              .where(
                and(
                  eq(integrations.refreshState, "refreshing"),
                  inArray(
                    integrations.refreshClaimId,
                    expiredProcessingReconnectStateHashes
                  )
                )
              );
          }
          if (expiredStateHashes.length > 0) {
            await tx
              .delete(oauthAuthorizationAttempts)
              .where(
                inArray(
                  oauthAuthorizationAttempts.stateHash,
                  expiredStateHashes
                )
              );
          }
          await tx.insert(oauthAuthorizationAttempts).values({
            stateHash: input.stateHash,
            integrationId: input.integrationId,
            mode: input.payload.kind,
            status: "pending",
            expiresAt: input.expiresAt,
            browserBindingHash: input.browserBindingHash,
            encryptedPayload: cipher.seal({
              payload: JSON.stringify(input.payload),
            }),
            updatedAt: now,
          });
        })
      ),

    claimOAuthAuthorizationAttempt: (input) =>
      database
        .query((db) =>
          db.transaction(async (tx) => {
            const now = new Date();
            const burned = await tx
              .update(oauthAuthorizationAttempts)
              .set({
                status: "failed",
                expiresAt: input.expiresAt,
                updatedAt: now,
              })
              .where(
                and(
                  eq(oauthAuthorizationAttempts.stateHash, input.stateHash),
                  eq(oauthAuthorizationAttempts.status, "pending"),
                  gt(oauthAuthorizationAttempts.expiresAt, now),
                  ne(
                    oauthAuthorizationAttempts.browserBindingHash,
                    input.browserBindingHash
                  )
                )
              )
              .returning({
                stateHash: oauthAuthorizationAttempts.stateHash,
              });
            if (burned.length > 0) return null;

            const [attempt] = await tx
              .update(oauthAuthorizationAttempts)
              .set({
                status: "processing",
                expiresAt: input.expiresAt,
                updatedAt: now,
              })
              .where(
                and(
                  eq(oauthAuthorizationAttempts.stateHash, input.stateHash),
                  eq(oauthAuthorizationAttempts.status, "pending"),
                  gt(oauthAuthorizationAttempts.expiresAt, now),
                  eq(
                    oauthAuthorizationAttempts.browserBindingHash,
                    input.browserBindingHash
                  )
                )
              )
              .returning({
                integrationId: oauthAuthorizationAttempts.integrationId,
                encryptedPayload: oauthAuthorizationAttempts.encryptedPayload,
              });
            return attempt ?? null;
          })
        )
        .pipe(Effect.flatMap(claimedAttempt)),

    readOAuthAuthorizationAttemptStatus: (input) =>
      database.query(async (db) => {
        const [attempt] = await db
          .select({
            status: oauthAuthorizationAttempts.status,
            resultIntegrationId: oauthAuthorizationAttempts.resultIntegrationId,
          })
          .from(oauthAuthorizationAttempts)
          .where(
            and(
              eq(oauthAuthorizationAttempts.stateHash, input.stateHash),
              eq(
                oauthAuthorizationAttempts.browserBindingHash,
                input.browserBindingHash
              ),
              gt(oauthAuthorizationAttempts.expiresAt, new Date())
            )
          )
          .limit(1);
        if (!attempt) return null;
        if (attempt.status === "succeeded") {
          return attempt.resultIntegrationId
            ? {
                status: "succeeded" as const,
                integrationId: attempt.resultIntegrationId,
              }
            : null;
        }
        return attempt.status === "failed"
          ? { status: "failed" as const }
          : { status: attempt.status };
      }),

    failOAuthAuthorizationAttempt: (input) =>
      database.query(async (db) => {
        const failed = await db
          .update(oauthAuthorizationAttempts)
          .set({
            status: "failed",
            expiresAt: input.expiresAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(oauthAuthorizationAttempts.stateHash, input.stateHash),
              eq(oauthAuthorizationAttempts.status, "processing")
            )
          )
          .returning({ stateHash: oauthAuthorizationAttempts.stateHash });
        return failed.length > 0;
      }),

    completeOAuthCreateAttempt: (input) =>
      database.query((db) =>
        db.transaction(async (tx) => {
          const eligible = await tx
            .select({ stateHash: oauthAuthorizationAttempts.stateHash })
            .from(oauthAuthorizationAttempts)
            .where(
              and(
                eq(oauthAuthorizationAttempts.stateHash, input.stateHash),
                eq(oauthAuthorizationAttempts.mode, "create"),
                eq(oauthAuthorizationAttempts.status, "processing")
              )
            )
            .for("update");
          if (eligible.length === 0) return false;

          await tx.insert(integrations).values({
            id: input.integrationId,
            name: input.name,
            type: input.type,
            config: cipher.seal(input.config),
          });
          const completed = await tx
            .update(oauthAuthorizationAttempts)
            .set({
              status: "succeeded",
              resultIntegrationId: input.integrationId,
              expiresAt: input.expiresAt,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(oauthAuthorizationAttempts.stateHash, input.stateHash),
                eq(oauthAuthorizationAttempts.status, "processing")
              )
            )
            .returning({ stateHash: oauthAuthorizationAttempts.stateHash });
          if (completed.length === 0) {
            throw new Error("OAuth attempt ownership was lost");
          }
          return true;
        })
      ),

    completeOAuthReconnectAttempt: (input) =>
      database.query((db) =>
        db.transaction(async (tx) => {
          const eligible = await tx
            .select({ stateHash: oauthAuthorizationAttempts.stateHash })
            .from(oauthAuthorizationAttempts)
            .where(
              and(
                eq(oauthAuthorizationAttempts.stateHash, input.stateHash),
                eq(
                  oauthAuthorizationAttempts.integrationId,
                  input.integrationId
                ),
                eq(oauthAuthorizationAttempts.mode, "reconnect"),
                eq(oauthAuthorizationAttempts.status, "processing")
              )
            )
            .for("update");
          if (eligible.length === 0) return false;

          const updated = await tx
            .update(integrations)
            .set({
              config: cipher.seal(input.config),
              configRevision: sql`${integrations.configRevision} + 1`,
              refreshState: "idle",
              refreshClaimId: null,
              refreshClaimedAt: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(integrations.id, input.integrationId),
                eq(integrations.refreshState, "refreshing"),
                eq(integrations.refreshClaimId, input.stateHash),
                eq(integrations.configRevision, input.expectedRevision)
              )
            )
            .returning({ id: integrations.id });
          if (updated.length === 0) return false;

          const completed = await tx
            .update(oauthAuthorizationAttempts)
            .set({
              status: "succeeded",
              resultIntegrationId: input.integrationId,
              expiresAt: input.expiresAt,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(oauthAuthorizationAttempts.stateHash, input.stateHash),
                eq(oauthAuthorizationAttempts.status, "processing")
              )
            )
            .returning({ stateHash: oauthAuthorizationAttempts.stateHash });
          if (completed.length === 0) {
            throw new Error("OAuth attempt ownership was lost");
          }
          return true;
        })
      ),
  };
}
