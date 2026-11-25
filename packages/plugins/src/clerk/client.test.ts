import {
  ExternalRejected,
  ExternalTransport,
  ExternalUnreachable,
  ExternalUnreadable,
  type JsonValue,
} from "@wfgraph/core/plugin";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  createClerkUser,
  deleteClerkUser,
  describeClerkFailure,
  getClerkUser,
  readClerkError,
  updateClerkUser,
  verifyClerkSecretKey,
} from "#src/clerk/client";
import { clerkResponses } from "#src/clerk/responses.fixtures";
import { recordFetch } from "#src/fetch-test-support";

/**
 * What goes on the wire for each Clerk call, which kind of failure each call
 * ends in, and how a failure reads. These assertions are the record of what
 * Clerk's Backend API reference (version 2026-08-20) says each request and
 * response looks like.
 */

const SECRET_KEY = "sk_test_secret";

const wire = recordFetch(() => Response.json(clerkResponses.user));

/** The part of `clerkResponses.user` the decode keeps. */
const DECODED_USER = {
  id: "user_2abc123",
  first_name: "Ada",
  last_name: "Lovelace",
  email_addresses: [
    { id: "idn_other", email_address: "other@example.com" },
    { id: "idn_primary", email_address: "ada@example.com" },
  ],
  primary_email_address_id: "idn_primary",
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_001_000,
};

/** A call that succeeds fails the flip, which is what makes the test say so. */
const failure = Effect.flip;

const withTransport = Effect.provide(ExternalTransport);

/** The method, URL and Clerk headers of the request at `index`. */
function sentRequest(index: number) {
  const request = wire.requests[index];
  return {
    method: request?.method,
    url: request?.url,
    authorization: request?.headers.get("authorization"),
    apiVersion: request?.headers.get("clerk-api-version"),
    contentType: request?.headers.get("content-type"),
  };
}

describe("getClerkUser", () => {
  it.effect(
    "reads the user with the secret key as a bearer token and a pinned API version",
    () =>
      Effect.gen(function* () {
        const user = yield* getClerkUser(SECRET_KEY, "user_2abc123");

        expect(user).toEqual(DECODED_USER);
        expect(wire.requests).toHaveLength(1);
        expect(sentRequest(0)).toEqual({
          method: "GET",
          url: "https://api.clerk.com/v1/users/user_2abc123",
          authorization: "Bearer sk_test_secret",
          apiVersion: "2026-08-20",
          contentType: null,
        });
      }).pipe(withTransport)
  );

  // A user id is template output, so it is escaped before it becomes a path.
  it.effect("escapes the user id in the path", () =>
    Effect.gen(function* () {
      yield* getClerkUser(SECRET_KEY, "user/../1?x");

      expect(wire.requests[0]?.url).toBe(
        "https://api.clerk.com/v1/users/user%2F..%2F1%3Fx"
      );
    }).pipe(withTransport)
  );

  it.effect("fails with Clerk's error body as the refusal's payload", () =>
    Effect.gen(function* () {
      wire.answer(() =>
        Response.json(clerkResponses.resourceNotFound, { status: 404 })
      );

      const error = yield* failure(getClerkUser(SECRET_KEY, "user_missing"));

      expect(error._tag).toBe("ExternalRejected");
      expect(
        error._tag === "ExternalRejected"
          ? readClerkError(error.payload)
          : undefined
      ).toEqual(clerkResponses.resourceNotFound);
    }).pipe(withTransport)
  );

  // Reporting success on a body that is not a user would hand the run an empty
  // user id.
  it.effect("refuses a 2xx that is not a User object", () =>
    Effect.gen(function* () {
      wire.answer(() => Response.json({ unexpected: true }));

      const error = yield* failure(getClerkUser(SECRET_KEY, "user_1"));

      expect(error._tag).toBe("ExternalUnreadable");
    }).pipe(withTransport)
  );
});

describe("verifyClerkSecretKey", () => {
  it.effect("asks for a list of one user with the secret key", () =>
    Effect.gen(function* () {
      wire.answer(() => Response.json([clerkResponses.user]));

      yield* verifyClerkSecretKey(SECRET_KEY);

      expect(wire.requests).toHaveLength(1);
      expect(sentRequest(0)).toEqual({
        method: "GET",
        url: "https://api.clerk.com/v1/users?limit=1",
        authorization: "Bearer sk_test_secret",
        apiVersion: "2026-08-20",
        contentType: null,
      });
    }).pipe(withTransport)
  );
});

describe("createClerkUser", () => {
  it.effect("posts Clerk's field names as JSON and drops unset fields", () =>
    Effect.gen(function* () {
      const user = yield* createClerkUser(SECRET_KEY, {
        email_address: ["ada@example.com"],
        first_name: "Ada",
        last_name: undefined,
        public_metadata: { role: "admin" },
      });

      expect(user).toEqual(DECODED_USER);
      expect(sentRequest(0)).toEqual({
        method: "POST",
        url: "https://api.clerk.com/v1/users",
        authorization: "Bearer sk_test_secret",
        apiVersion: "2026-08-20",
        contentType: "application/json",
      });
      expect(wire.body(0)).toEqual({
        email_address: ["ada@example.com"],
        first_name: "Ada",
        public_metadata: { role: "admin" },
      });
    }).pipe(withTransport)
  );

  // Clerk's create-user endpoint takes no idempotency key, so a create that
  // may have reached Clerk is not sent again.
  it.effect("does not send the create a second time", () =>
    Effect.gen(function* () {
      wire.answer(() => new Response(null, { status: 503 }));

      yield* failure(
        createClerkUser(SECRET_KEY, { email_address: ["ada@example.com"] })
      );

      expect(wire.requests).toHaveLength(1);
    }).pipe(withTransport)
  );
});

describe("updateClerkUser", () => {
  it.effect("patches only the names that are set", () =>
    Effect.gen(function* () {
      const user = yield* updateClerkUser(SECRET_KEY, "user_2abc123", {
        first_name: undefined,
        last_name: "Byron",
      });

      expect(user).toEqual(DECODED_USER);
      expect(wire.requests).toHaveLength(1);
      expect(sentRequest(0)).toEqual({
        method: "PATCH",
        url: "https://api.clerk.com/v1/users/user_2abc123",
        authorization: "Bearer sk_test_secret",
        apiVersion: "2026-08-20",
        contentType: "application/json",
      });
      expect(wire.body(0)).toEqual({ last_name: "Byron" });
    }).pipe(withTransport)
  );

  // From API version 2026-05-12 the PATCH refuses metadata, which Clerk takes
  // on its own endpoint instead.
  it.effect("replaces metadata through the metadata endpoint alone", () =>
    Effect.gen(function* () {
      yield* updateClerkUser(SECRET_KEY, "user_2abc123", {
        private_metadata: { internal_id: "123" },
      });

      expect(wire.requests).toHaveLength(1);
      expect(sentRequest(0)).toEqual({
        method: "PUT",
        url: "https://api.clerk.com/v1/users/user_2abc123/metadata",
        authorization: "Bearer sk_test_secret",
        apiVersion: "2026-08-20",
        contentType: "application/json",
      });
      expect(wire.body(0)).toEqual({
        private_metadata: { internal_id: "123" },
      });
    }).pipe(withTransport)
  );

  it.effect(
    "patches the names, then replaces the metadata, and answers with the second user",
    () =>
      Effect.gen(function* () {
        wire.answer((request) =>
          Response.json(
            request.method === "PUT"
              ? { ...clerkResponses.user, updated_at: 1_700_000_002_000 }
              : clerkResponses.user
          )
        );

        const user = yield* updateClerkUser(SECRET_KEY, "user_2abc123", {
          first_name: "Ada",
          public_metadata: { role: "admin" },
        });

        expect(wire.requests.map((request) => request.method)).toEqual([
          "PATCH",
          "PUT",
        ]);
        expect(wire.bodies()).toEqual([
          { first_name: "Ada" },
          { public_metadata: { role: "admin" } },
        ]);
        expect(user.updated_at).toBe(1_700_000_002_000);
      }).pipe(withTransport)
  );

  // Nothing to change still reads the user back, so the step answers with it.
  it.effect("sends an empty patch when nothing is set", () =>
    Effect.gen(function* () {
      yield* updateClerkUser(SECRET_KEY, "user_2abc123", {});

      expect(sentRequest(0).method).toBe("PATCH");
      expect(wire.body(0)).toEqual({});
    }).pipe(withTransport)
  );

  it.effect("stops at a refused patch", () =>
    Effect.gen(function* () {
      wire.answer(() =>
        Response.json(clerkResponses.resourceNotFound, { status: 404 })
      );

      const error = yield* failure(
        updateClerkUser(SECRET_KEY, "user_missing", {
          first_name: "Ada",
          public_metadata: {},
        })
      );

      expect(error._tag).toBe("ExternalRejected");
      expect(wire.requests).toHaveLength(1);
    }).pipe(withTransport)
  );

  // The two requests are separate writes, so the names stay changed and the
  // update as a whole fails.
  it.effect("fails when the metadata is refused after the patch", () =>
    Effect.gen(function* () {
      wire.answer((request) =>
        request.method === "PUT"
          ? Response.json(clerkResponses.resourceNotFound, { status: 404 })
          : Response.json(clerkResponses.user)
      );

      const error = yield* failure(
        updateClerkUser(SECRET_KEY, "user_2abc123", {
          first_name: "Ada",
          public_metadata: {},
        })
      );

      expect(error._tag).toBe("ExternalRejected");
      expect(wire.requests.map((request) => request.method)).toEqual([
        "PATCH",
        "PUT",
      ]);
    }).pipe(withTransport)
  );

  // On the live clock, because the retry waits out the Retry-After header.
  // Setting the same names twice leaves Clerk holding the same user.
  it.live("sends the patch again after a rate limit", () =>
    Effect.gen(function* () {
      let calls = 0;
      wire.answer(() => {
        calls += 1;
        return calls === 1
          ? Response.json(
              { errors: [] },
              { status: 429, headers: { "retry-after": "0" } }
            )
          : Response.json(clerkResponses.user);
      });

      yield* updateClerkUser(SECRET_KEY, "user_2abc123", { last_name: "B" });

      expect(wire.requests.map((request) => request.method)).toEqual([
        "PATCH",
        "PATCH",
      ]);
    }).pipe(withTransport)
  );
});

describe("deleteClerkUser", () => {
  it.effect("deletes the user and reads Clerk's DeletedObject", () =>
    Effect.gen(function* () {
      wire.answer(() => Response.json(clerkResponses.deletedUser));

      const deleted = yield* deleteClerkUser(SECRET_KEY, "user_2abc123");

      expect(deleted).toEqual(clerkResponses.deletedUser);
      expect(sentRequest(0)).toEqual({
        method: "DELETE",
        url: "https://api.clerk.com/v1/users/user_2abc123",
        authorization: "Bearer sk_test_secret",
        apiVersion: "2026-08-20",
        contentType: null,
      });
    }).pipe(withTransport)
  );

  // A repeat after Clerk deleted the user but its answer was lost would come
  // back 404 and report the completed delete as a missing user. The 503 is a
  // refusal a read would be retried on.
  it.effect("sends the delete once even when Clerk is unavailable", () =>
    Effect.gen(function* () {
      wire.answer(() => new Response(null, { status: 503 }));

      const error = yield* failure(deleteClerkUser(SECRET_KEY, "user_2abc123"));

      expect(error._tag).toBe("ExternalRejected");
      expect(wire.requests).toHaveLength(1);
    }).pipe(withTransport)
  );
});

describe("describeClerkFailure", () => {
  function rejected(status: number, payload: JsonValue | undefined) {
    return new ExternalRejected({
      status,
      payload,
      retryAfterSeconds: undefined,
    });
  }

  // Clerk's refusal carries a list of errors, and the first of those is the
  // sentence a user can act on.
  it("reports the first message in Clerk's error list", () => {
    expect(
      describeClerkFailure(rejected(422, clerkResponses.formIdentifierExists))
    ).toBe("That email address is taken. Please try another.");
  });

  // Something standing in front of the API answers without Clerk's error body.
  it("reports the status of a refusal whose body is not Clerk's", () => {
    expect(describeClerkFailure(rejected(502, undefined))).toBe("502");
  });

  it("says what the transport said for a request that never arrived", () => {
    expect(
      describeClerkFailure(
        new ExternalUnreachable({ message: "socket hang up" })
      )
    ).toBe("socket hang up");
  });

  it("names a success whose body could not be read", () => {
    expect(describeClerkFailure(new ExternalUnreadable({ status: 200 }))).toBe(
      "Clerk answered 200 with an unrecognized body"
    );
  });
});
