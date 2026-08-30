import { randomBytes } from "node:crypto";
import { compare, hash } from "bcryptjs";
import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailure } from "#src/backend/lib/effect/internal-failure";
import {
  InternalFailure,
  Unauthorized,
} from "#src/backend/lib/effect/failures";
import { ApiKeyRepo } from "#src/backend/services/api-keys/repo";

const API_KEY_PREFIX = "wfb_";
const API_KEY_PREFIX_LENGTH = 11;

/**
 * The key an `Authorization` header carries, or the reason it carries none.
 *
 * A header that cannot hold a key is already a rejected request, so this answers
 * in the error channel rather than handing back a maybe-key the caller has to
 * remember to check.
 */
function parseApiKeyFromAuthHeader(
  authHeader: string | null
): Effect.Effect<string, Unauthorized> {
  if (!authHeader) {
    return Effect.fail(
      new Unauthorized({ error: "Missing Authorization header" })
    );
  }

  const key = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;

  if (!key.startsWith(API_KEY_PREFIX)) {
    return Effect.fail(new Unauthorized({ error: "Invalid API key format" }));
  }

  return Effect.succeed(key);
}

/**
 * Mint a key: the plaintext the caller is shown once, and the hash we keep.
 *
 * bcrypt failing is nothing the caller can act on, so it arrives as the same
 * internal failure the only caller would have reported anyway.
 */
export const createApiKeyRecord = Effect.fn("createApiKeyRecord")(function* () {
  const randomPart = randomBytes(24).toString("base64url");
  const key = `${API_KEY_PREFIX}${randomPart}`;

  const keyHash = yield* Effect.tryPromise({
    try: () => hash(key, 10),
    catch: (cause) =>
      new InternalFailure({ error: "Failed to create API key", cause }),
  });

  return { key, keyHash, keyPrefix: key.slice(0, API_KEY_PREFIX_LENGTH) };
});

/**
 * Verify an inbound Authorization header against the stored keys, answering
 * with the id of the key that matched.
 *
 * The visible prefix is indexed and the hash is not, so a lookup by prefix
 * narrows the work to the few keys that could match and bcrypt compares those
 * one at a time. A comparison that throws is logged and skipped rather than
 * failing the whole verification, because one unreadable row should not lock
 * out a caller whose key is stored in another.
 *
 * Every rejection is an `Unauthorized` in the error channel, so a caller cannot
 * read past one, and a database that will not answer is an `InternalFailure`
 * rather than a rejected promise a caller would have to know to catch.
 */
export const validateApiKey = Effect.fn("validateApiKey")(function* (
  authHeader: string | null
) {
  const apiKey = yield* parseApiKeyFromAuthHeader(authHeader);
  const repo = yield* ApiKeyRepo;
  const logger = (yield* AppLogger).get("api-keys", "auth");

  const candidates = yield* repo
    .findByPrefix(apiKey.slice(0, API_KEY_PREFIX_LENGTH))
    .pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailure(logger, "Failed to verify API key")
      )
    );

  for (const candidate of candidates) {
    const isMatch = yield* Effect.tryPromise(() =>
      compare(apiKey, candidate.keyHash)
    ).pipe(
      Effect.catch((error) =>
        logger
          .warn("Failed to verify API key candidate hash", {
            keyId: candidate.id,
            error: error.cause,
          })
          .pipe(Effect.as(false))
      )
    );

    if (isMatch) {
      // The stamp is part of the request: a forked fiber belongs to no scope the
      // app closes, so it can outlive the database pool it queries. The write
      // costs far less than the bcrypt compare above it, and a failure is a log
      // line rather than a rejected request.
      yield* repo.touchLastUsed(candidate.id).pipe(
        Effect.catch((error) =>
          logger.warn("Failed to update API key last-used timestamp", {
            keyId: candidate.id,
            error: error.cause,
          })
        )
      );

      return { keyId: candidate.id };
    }
  }

  return yield* new Unauthorized({ error: "Invalid API key" });
});
