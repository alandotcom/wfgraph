/**
 * Clerk's Backend API over `callExternal`.
 *
 * The integration reads, creates, updates and deletes users, and lists one user
 * to check a secret key. Each call sends the secret key as a bearer token and
 * pins the API version with the `Clerk-API-Version` header, so the request and
 * response shapes in this file are the ones that version documents. Clerk takes
 * JSON bodies in snake_case and answers JSON in snake_case.
 */

import type { JsonObject, JsonValue } from "@wfgraph/core/plugin";
import {
  callExternal,
  parsePayload,
  type ExternalError,
} from "@wfgraph/core/plugin";
import type { JsonObjectDraft } from "@wfgraph/shared/types/json";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { Effect, Schema } from "effect";
import type { HttpClient, HttpMethod } from "effect/http";
import { type ClerkApiUser, clerkApiUserSchema } from "#src/clerk/types";

const CLERK_API_BASE = "https://api.clerk.com/v1";

/**
 * The Backend API version every request asks for. Clerk versions its API by
 * release date, and the user endpoints take different bodies in different
 * versions: from 2026-05-12, `PATCH /users/{user_id}` refuses metadata.
 */
const CLERK_API_VERSION = "2026-08-20";

/** Clerk's error body, the same shape on every endpoint and status. */
const clerkErrorBodySchema = Schema.Struct({
  errors: Schema.Array(
    Schema.Struct({
      message: Schema.String,
      long_message: Schema.String,
      code: Schema.String,
    })
  ),
  clerk_trace_id: Schema.optionalKey(Schema.String),
});

export type ClerkErrorBody = typeof clerkErrorBodySchema.Type;

/** Clerk's error body, for a caller that reports more than the sentence. */
export function readClerkError(
  payload: JsonValue | undefined
): ClerkErrorBody | undefined {
  return parsePayload(payload, clerkErrorBodySchema);
}

/**
 * What Clerk said, in one sentence a person reads.
 *
 * A refusal carries the `message` of the first entry in Clerk's `errors` list
 * when the body is Clerk's error shape, and the bare status code when it is not,
 * which is what something standing in front of the API answers with. A 2xx
 * whose body is not the documented resource says so, because reporting success
 * there would hand the run an empty user.
 */
export function describeClerkFailure(error: ExternalError): string {
  if (error._tag === "ExternalUnreachable") {
    return error.message;
  }

  if (error._tag === "ExternalUnreadable") {
    return `Clerk answered ${error.status} with an unrecognized body`;
  }

  const firstMessage = readClerkError(error.payload)?.errors[0]?.message;
  return firstMessage || String(error.status);
}

function requestClerk<S extends Schema.ConstraintDecoder<unknown>>(
  secretKey: string,
  init: {
    method: HttpMethod.HttpMethod;
    path: string;
    schema: S;
    body?: JsonObject | undefined;
    safeToRepeat?: true | undefined;
  }
): Effect.Effect<S["Type"], ExternalError, HttpClient.HttpClient> {
  return callExternal({
    system: "Clerk",
    url: `${CLERK_API_BASE}${init.path}`,
    method: init.method,
    headers: {
      authorization: `Bearer ${secretKey}`,
      "clerk-api-version": CLERK_API_VERSION,
    },
    body:
      init.body === undefined ? undefined : { kind: "json", value: init.body },
    schema: init.schema,
    safeToRepeat: init.safeToRepeat,
  });
}

function userPath(userId: string): string {
  return `/users/${encodeURIComponent(userId)}`;
}

/** `GET /users/{user_id}`. A GET is retried by `callExternal` on its own. */
export function getClerkUser(
  secretKey: string,
  userId: string
): Effect.Effect<ClerkApiUser, ExternalError, HttpClient.HttpClient> {
  return requestClerk(secretKey, {
    method: "GET",
    path: userPath(userId),
    schema: clerkApiUserSchema,
  });
}

/**
 * Check that Clerk accepts a secret key, with `GET /users?limit=1`, the
 * cheapest call a secret key can make. The call succeeds when a list arrives;
 * its entries are not read.
 */
export function verifyClerkSecretKey(
  secretKey: string
): Effect.Effect<void, ExternalError, HttpClient.HttpClient> {
  return requestClerk(secretKey, {
    method: "GET",
    path: `/users?${new URLSearchParams({ limit: "1" })}`,
    schema: Schema.Array(Schema.Unknown),
  }).pipe(Effect.asVoid);
}

/** The `POST /users` body fields the Create User action sends. */
export type ClerkCreateUserBody = {
  /** Clerk makes the first address in the list the primary address. */
  email_address: string[];
  first_name?: string | undefined;
  last_name?: string | undefined;
  password?: string | undefined;
  public_metadata?: JsonObject | undefined;
  private_metadata?: JsonObject | undefined;
};

/**
 * `POST /users`, with the fields left undefined dropped from the body.
 *
 * Creating a user is not retried. Clerk's create-user endpoint takes no
 * idempotency key, so a repeat after a response that was lost on the way back
 * would ask Clerk to create the user a second time, and Clerk would refuse it
 * because the address is taken, which fails a step whose user exists.
 */
export function createClerkUser(
  secretKey: string,
  body: ClerkCreateUserBody
): Effect.Effect<ClerkApiUser, ExternalError, HttpClient.HttpClient> {
  return requestClerk(secretKey, {
    method: "POST",
    path: "/users",
    schema: clerkApiUserSchema,
    body: omitUndefined<JsonObjectDraft>(body),
  });
}

/**
 * The fields the Update User action changes. Clerk takes the names on
 * `PATCH /users/{user_id}` and the metadata on `PUT /users/{user_id}/metadata`,
 * since this API version refuses metadata on the PATCH.
 */
export type ClerkUserUpdate = {
  first_name?: string | undefined;
  last_name?: string | undefined;
  public_metadata?: JsonObject | undefined;
  private_metadata?: JsonObject | undefined;
};

/**
 * Update a user and answer with the user as Clerk holds it afterwards.
 *
 * Fields left undefined are left out, so Clerk keeps what it holds for them.
 * The names go out on `PATCH /users/{user_id}`, sent when there is a name to
 * change or no metadata to replace. Each metadata field that is set replaces the
 * stored field whole through `PUT /users/{user_id}/metadata`, sent after the
 * PATCH, and the user that call answers with is the result.
 *
 * An update with no fields set still sends the `PATCH`, with an empty body, so
 * the action can answer with the user as Clerk holds it.
 *
 * The two requests are separate writes. When the `PATCH` succeeds and the
 * metadata `PUT` fails, Clerk keeps the changed names and the effect fails with
 * the `PUT`'s error, which fails the step.
 *
 * Both requests are retried by `callExternal`: each one sets fields to the
 * values given, so sending it a second time leaves Clerk holding the same user.
 */
export function updateClerkUser(
  secretKey: string,
  userId: string,
  update: ClerkUserUpdate
): Effect.Effect<ClerkApiUser, ExternalError, HttpClient.HttpClient> {
  const names = omitUndefined<JsonObjectDraft>({
    first_name: update.first_name,
    last_name: update.last_name,
  });
  const metadata = omitUndefined<JsonObjectDraft>({
    public_metadata: update.public_metadata,
    private_metadata: update.private_metadata,
  });
  const hasNames = Object.keys(names).length > 0;
  const hasMetadata = Object.keys(metadata).length > 0;

  const patchNames = requestClerk(secretKey, {
    method: "PATCH",
    path: userPath(userId),
    schema: clerkApiUserSchema,
    body: names,
    safeToRepeat: true,
  });

  if (!hasMetadata) {
    return patchNames;
  }

  const replaceMetadata = requestClerk(secretKey, {
    method: "PUT",
    path: `${userPath(userId)}/metadata`,
    schema: clerkApiUserSchema,
    body: metadata,
    safeToRepeat: true,
  });

  return hasNames
    ? Effect.andThen(patchNames, replaceMetadata)
    : replaceMetadata;
}

/** Clerk's DeletedObject, which answers `DELETE /users/{user_id}`. */
const clerkDeletedObjectSchema = Schema.Struct({
  object: Schema.String,
  id: Schema.optionalKey(Schema.String),
  deleted: Schema.Boolean,
});

/**
 * `DELETE /users/{user_id}`.
 *
 * The request is sent once. `callExternal` repeats only a GET, a HEAD, a write
 * carrying an idempotency key, or a request marked `safeToRepeat`, and this
 * DELETE is none of those, so no failure of it is retried: a rate limit, an
 * unavailable answer, a connection that never opened and an answer that missed
 * the attempt timeout each fail the call on the first attempt. A repeat after
 * Clerk deleted the user but the answer was lost would be answered 404, which
 * would report a completed delete as a user that was not found. The step that
 * calls this fails with a `StepFailure`, which the executor stores and does not
 * run again.
 */
export function deleteClerkUser(
  secretKey: string,
  userId: string
): Effect.Effect<
  typeof clerkDeletedObjectSchema.Type,
  ExternalError,
  HttpClient.HttpClient
> {
  return requestClerk(secretKey, {
    method: "DELETE",
    path: userPath(userId),
    schema: clerkDeletedObjectSchema,
  });
}
