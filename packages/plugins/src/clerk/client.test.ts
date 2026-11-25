import { ExternalTransport } from "@wfgraph/core/plugin";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, beforeEach } from "vitest";
import {
  createClerkUser,
  deleteClerkUser,
  describeClerkFailure,
  getClerkUser,
  listClerkUsers,
  readClerkError,
  updateClerkUser,
} from "#src/clerk/client";

/**
 * What goes on the wire for each Clerk call, and how Clerk's answers decode.
 * These assertions are the record of what Clerk's Backend API reference
 * (version 2026-08-20) says each request and response looks like.
 */

const realFetch = globalThis.fetch;
const SECRET_KEY = "sk_test_secret";
let requests: Request[] = [];

/**
 * A User object with every property Clerk's reference marks required, so the
 * decode is checked against the whole resource rather than the fields it reads.
 */
const CLERK_USER = {
  id: "user_2abc123",
  object: "user",
  username: null,
  first_name: "Ada",
  last_name: "Lovelace",
  has_image: false,
  primary_email_address_id: "idn_primary",
  primary_phone_number_id: null,
  primary_web3_wallet_id: null,
  password_enabled: false,
  two_factor_enabled: false,
  totp_enabled: false,
  backup_code_enabled: false,
  email_addresses: [
    {
      id: "idn_other",
      object: "email_address",
      email_address: "other@example.com",
      reserved: false,
      verification: {
        object: "verification_admin",
        status: "verified",
        strategy: "admin",
        attempts: null,
        expire_at: null,
      },
      linked_to: [],
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
    },
    {
      id: "idn_primary",
      object: "email_address",
      email_address: "ada@example.com",
      reserved: false,
      verification: {
        object: "verification_admin",
        status: "verified",
        strategy: "admin",
        attempts: null,
        expire_at: null,
      },
      linked_to: [],
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
    },
  ],
  phone_numbers: [],
  web3_wallets: [],
  passkeys: [],
  external_accounts: [],
  saml_accounts: [],
  enterprise_accounts: [],
  public_metadata: { role: "admin" },
  private_metadata: {},
  external_id: null,
  last_sign_in_at: null,
  banned: false,
  locked: false,
  lockout_expires_in_seconds: null,
  verification_attempts_remaining: 100,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_001_000,
  delete_self_enabled: true,
  create_organization_enabled: true,
  last_active_at: null,
  mfa_enabled_at: null,
  mfa_disabled_at: null,
  legal_accepted_at: null,
};

/** The part of `CLERK_USER` the decode keeps. */
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

/** Clerk's documented `ResourceNotFound` error, status 404. */
const RESOURCE_NOT_FOUND = {
  errors: [
    {
      message: "not found",
      long_message: "Resource not found",
      code: "resource_not_found",
    },
  ],
};

/** Clerk's documented `FormIdentifierExists` error, status 422. */
const FORM_IDENTIFIER_EXISTS = {
  errors: [
    {
      message: "That email address is taken. Please try another.",
      long_message: "That email address is taken. Please try another.",
      code: "form_identifier_exists",
      meta: { param_name: "email_address" },
    },
  ],
  clerk_trace_id: "trace_1",
};

function stubFetch(
  respond: (request: Request) => Response | Promise<Response>
): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(respond(request));
  }) as typeof fetch;
}

/** A call that succeeds fails the flip, which is what makes the test say so. */
const failure = Effect.flip;

const withTransport = Effect.provide(ExternalTransport);

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The method, URL and Clerk headers of the request at `index`. */
function sentRequest(index: number) {
  const request = requests[index];
  return {
    method: request?.method,
    url: request?.url,
    authorization: request?.headers.get("authorization"),
    apiVersion: request?.headers.get("clerk-api-version"),
    contentType: request?.headers.get("content-type"),
  };
}

/** The JSON body of the request at `index`. */
function sentBody(index: number): Effect.Effect<unknown> {
  return Effect.promise(() => {
    const request = requests[index];
    if (!request) {
      throw new Error(`no request ${index} was sent`);
    }
    return request.json();
  });
}

describe("getClerkUser", () => {
  it.effect(
    "reads the user with the secret key as a bearer token and a pinned API version",
    () =>
      Effect.gen(function* () {
        stubFetch(() => Response.json(CLERK_USER));

        const user = yield* getClerkUser(SECRET_KEY, "user_2abc123");

        expect(user).toEqual(DECODED_USER);
        expect(requests).toHaveLength(1);
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
      stubFetch(() => Response.json(CLERK_USER));

      yield* getClerkUser(SECRET_KEY, "user/../1?x");

      expect(requests[0]?.url).toBe(
        "https://api.clerk.com/v1/users/user%2F..%2F1%3Fx"
      );
    }).pipe(withTransport)
  );

  it.effect("reads Clerk's error body back", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json(RESOURCE_NOT_FOUND, { status: 404 }));

      const error = yield* failure(getClerkUser(SECRET_KEY, "user_missing"));

      expect(error._tag).toBe("ExternalRejected");
      expect(describeClerkFailure(error)).toBe("not found");
      expect(
        error._tag === "ExternalRejected"
          ? readClerkError(error.payload)
          : undefined
      ).toEqual(RESOURCE_NOT_FOUND);
    }).pipe(withTransport)
  );

  it.effect("falls back to the status when the body is not Clerk's shape", () =>
    Effect.gen(function* () {
      stubFetch(() => new Response("<html>gateway</html>", { status: 502 }));

      const error = yield* failure(getClerkUser(SECRET_KEY, "user_1"));

      expect(error._tag).toBe("ExternalRejected");
      expect(describeClerkFailure(error)).toBe("502");
    }).pipe(withTransport)
  );

  // Reporting success on a body that is not a user would hand the run an empty
  // user id.
  it.effect("refuses a 2xx that is not a User object", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json({ unexpected: true }));

      const error = yield* failure(getClerkUser(SECRET_KEY, "user_1"));

      expect(error._tag).toBe("ExternalUnreadable");
      expect(describeClerkFailure(error)).toBe(
        "Clerk answered 200 with an unrecognized body"
      );
    }).pipe(withTransport)
  );
});

describe("listClerkUsers", () => {
  it.effect("asks for one page of the given size", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json([CLERK_USER]));

      const users = yield* listClerkUsers(SECRET_KEY, 1);

      expect(users).toHaveLength(1);
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
      stubFetch(() => Response.json(CLERK_USER));

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
      expect(yield* sentBody(0)).toEqual({
        email_address: ["ada@example.com"],
        first_name: "Ada",
        public_metadata: { role: "admin" },
      });
    }).pipe(withTransport)
  );

  it.effect("reports the first message of Clerk's refusal", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json(FORM_IDENTIFIER_EXISTS, { status: 422 }));

      const error = yield* failure(
        createClerkUser(SECRET_KEY, { email_address: ["ada@example.com"] })
      );

      expect(describeClerkFailure(error)).toBe(
        "That email address is taken. Please try another."
      );
    }).pipe(withTransport)
  );

  // Clerk's create-user endpoint takes no idempotency key, so a create that
  // may have reached Clerk is not sent again.
  it.effect("does not send the create a second time", () =>
    Effect.gen(function* () {
      stubFetch(() => new Response(null, { status: 503 }));

      yield* failure(
        createClerkUser(SECRET_KEY, { email_address: ["ada@example.com"] })
      );

      expect(requests).toHaveLength(1);
    }).pipe(withTransport)
  );
});

describe("updateClerkUser", () => {
  it.effect("patches only the names that are set", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json(CLERK_USER));

      const user = yield* updateClerkUser(SECRET_KEY, "user_2abc123", {
        first_name: undefined,
        last_name: "Byron",
      });

      expect(user).toEqual(DECODED_USER);
      expect(requests).toHaveLength(1);
      expect(sentRequest(0)).toEqual({
        method: "PATCH",
        url: "https://api.clerk.com/v1/users/user_2abc123",
        authorization: "Bearer sk_test_secret",
        apiVersion: "2026-08-20",
        contentType: "application/json",
      });
      expect(yield* sentBody(0)).toEqual({ last_name: "Byron" });
    }).pipe(withTransport)
  );

  // From API version 2026-05-12 the PATCH refuses metadata, which Clerk takes
  // on its own endpoint instead.
  it.effect("replaces metadata through the metadata endpoint alone", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json(CLERK_USER));

      yield* updateClerkUser(SECRET_KEY, "user_2abc123", {
        private_metadata: { internal_id: "123" },
      });

      expect(requests).toHaveLength(1);
      expect(sentRequest(0)).toEqual({
        method: "PUT",
        url: "https://api.clerk.com/v1/users/user_2abc123/metadata",
        authorization: "Bearer sk_test_secret",
        apiVersion: "2026-08-20",
        contentType: "application/json",
      });
      expect(yield* sentBody(0)).toEqual({
        private_metadata: { internal_id: "123" },
      });
    }).pipe(withTransport)
  );

  it.effect(
    "patches the names, then replaces the metadata, and answers with the second user",
    () =>
      Effect.gen(function* () {
        stubFetch((request) =>
          Response.json(
            request.method === "PUT"
              ? { ...CLERK_USER, updated_at: 1_700_000_002_000 }
              : CLERK_USER
          )
        );

        const user = yield* updateClerkUser(SECRET_KEY, "user_2abc123", {
          first_name: "Ada",
          public_metadata: { role: "admin" },
        });

        expect(requests.map((request) => request.method)).toEqual([
          "PATCH",
          "PUT",
        ]);
        expect(yield* sentBody(0)).toEqual({ first_name: "Ada" });
        expect(yield* sentBody(1)).toEqual({
          public_metadata: { role: "admin" },
        });
        expect(user.updated_at).toBe(1_700_000_002_000);
      }).pipe(withTransport)
  );

  // Nothing to change still reads the user back, so the step answers with it.
  it.effect("sends an empty patch when nothing is set", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json(CLERK_USER));

      yield* updateClerkUser(SECRET_KEY, "user_2abc123", {});

      expect(sentRequest(0).method).toBe("PATCH");
      expect(yield* sentBody(0)).toEqual({});
    }).pipe(withTransport)
  );

  it.effect("stops at a refused patch", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json(RESOURCE_NOT_FOUND, { status: 404 }));

      const error = yield* failure(
        updateClerkUser(SECRET_KEY, "user_missing", {
          first_name: "Ada",
          public_metadata: {},
        })
      );

      expect(describeClerkFailure(error)).toBe("not found");
      expect(requests).toHaveLength(1);
    }).pipe(withTransport)
  );

  // On the live clock, because the retry waits out the Retry-After header.
  // Setting the same names twice leaves Clerk holding the same user.
  it.live("sends the patch again after a rate limit", () =>
    Effect.gen(function* () {
      let calls = 0;
      stubFetch(() => {
        calls += 1;
        return calls === 1
          ? Response.json(
              { errors: [] },
              { status: 429, headers: { "retry-after": "0" } }
            )
          : Response.json(CLERK_USER);
      });

      yield* updateClerkUser(SECRET_KEY, "user_2abc123", { last_name: "B" });

      expect(requests.map((request) => request.method)).toEqual([
        "PATCH",
        "PATCH",
      ]);
    }).pipe(withTransport)
  );
});

describe("deleteClerkUser", () => {
  it.effect("deletes the user and reads Clerk's DeletedObject", () =>
    Effect.gen(function* () {
      stubFetch(() =>
        Response.json({ object: "user", id: "user_2abc123", deleted: true })
      );

      const deleted = yield* deleteClerkUser(SECRET_KEY, "user_2abc123");

      expect(deleted).toEqual({
        object: "user",
        id: "user_2abc123",
        deleted: true,
      });
      expect(sentRequest(0)).toEqual({
        method: "DELETE",
        url: "https://api.clerk.com/v1/users/user_2abc123",
        authorization: "Bearer sk_test_secret",
        apiVersion: "2026-08-20",
        contentType: null,
      });
    }).pipe(withTransport)
  );
});
