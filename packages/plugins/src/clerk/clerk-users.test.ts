import { describe, expect, it } from "@effect/vitest";
import { actionData, actionError, runAction } from "@wfgraph/core/testing";
import { Effect } from "effect";
import { afterEach, beforeEach } from "vitest";
import { clerk } from "#src/clerk/index";

const underTest = clerk;

/**
 * The four Clerk steps in one file, because what they have to say is the same
 * four things each: which credential is missing, which field the action cannot
 * do without, what Clerk's user looks like flattened, and how Clerk's refusal
 * reads. The seam under all of them is `fetch`, so a case says what Clerk
 * answered and reads back both the step's answer and the request it sent.
 * What each request looks like in full is `client.test.ts`'s subject.
 */

const CLERK_CREDENTIALS = { CLERK_SECRET_KEY: "sk_test_key" };

// What Clerk's Backend API answers, in its own snake_case, so the step's
// flattening is exercised rather than assumed.
const CLERK_USER = {
  id: "user_1",
  object: "user",
  first_name: "Ada",
  last_name: "Lovelace",
  email_addresses: [
    { id: "idn_1", object: "email_address", email_address: "ada@example.com" },
    {
      id: "idn_2",
      object: "email_address",
      email_address: "other@example.com",
    },
  ],
  primary_email_address_id: "idn_1",
  public_metadata: {},
  private_metadata: {},
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_001_000,
};

/** The user the three user-returning steps answer with, flattened. */
const FLATTENED_USER = {
  id: "user_1",
  firstName: "Ada",
  lastName: "Lovelace",
  primaryEmailAddress: "ada@example.com",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_001_000,
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

const realFetch = globalThis.fetch;
let requests: Request[] = [];

/** Answer every request Clerk would get with `respond`. */
function stubFetch(respond: () => Response): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return Promise.resolve(respond());
  }) as typeof fetch;
}

/** The method and URL of each request sent, in order. */
function sentRequests(): string[] {
  return requests.map((request) => `${request.method} ${request.url}`);
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

/** The credentials a run would have fetched. */
function credentialsRead(
  values: Record<string, string | undefined> = CLERK_CREDENTIALS
) {
  return Effect.sync(() => values);
}

beforeEach(() => {
  requests = [];
  stubFetch(() => Response.json(CLERK_USER));
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("clerk/get-user", () => {
  it.effect("flattens Clerk's user around its primary address", () =>
    Effect.gen(function* () {
      const result = actionData(
        yield* runAction(underTest, "get-user", {
          input: { userId: "user_1" },
          credentials: credentialsRead(),
        })
      );

      expect(sentRequests()).toEqual([
        "GET https://api.clerk.com/v1/users/user_1",
      ]);
      expect(requests[0]?.headers.get("authorization")).toBe(
        "Bearer sk_test_key"
      );
      expect(result).toEqual(FLATTENED_USER);
    })
  );

  it.effect("names the missing credential before reaching Clerk", () =>
    Effect.gen(function* () {
      const error = actionError(
        yield* runAction(underTest, "get-user", {
          input: { userId: "user_1" },
          credentials: credentialsRead({}),
        })
      );

      expect(error.message).toBe(
        "CLERK_SECRET_KEY is not configured. Please add it in Project Integrations."
      );
      expect(requests).toHaveLength(0);
    })
  );

  it.effect("asks for a user id before reaching Clerk", () =>
    Effect.gen(function* () {
      const error = actionError(
        yield* runAction(underTest, "get-user", {
          input: { userId: "" },
          credentials: credentialsRead(),
        })
      );

      expect(error.message).toBe("User ID is required.");
      expect(requests).toHaveLength(0);
    })
  );

  // Clerk's refusal carries a list of errors, and the first of those is the
  // sentence a user can act on.
  it.effect("reports the message Clerk's error carries", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json(RESOURCE_NOT_FOUND, { status: 404 }));

      const error = actionError(
        yield* runAction(underTest, "get-user", {
          input: { userId: "user_missing" },
          credentials: credentialsRead(),
        })
      );

      expect(error.message).toBe("Failed to get user: not found");
    })
  );
});

describe("clerk/create-user", () => {
  it.effect("sends the address as the list Clerk takes", () =>
    Effect.gen(function* () {
      const result = actionData(
        yield* runAction(underTest, "create-user", {
          input: {
            emailAddress: "ada@example.com",
            firstName: "Ada",
            publicMetadata: '{"role":"admin"}',
          },
          credentials: credentialsRead(),
        })
      );

      expect(sentRequests()).toEqual(["POST https://api.clerk.com/v1/users"]);
      expect(yield* sentBody(0)).toEqual({
        email_address: ["ada@example.com"],
        first_name: "Ada",
        public_metadata: { role: "admin" },
      });
      expect(result).toEqual(FLATTENED_USER);
    })
  );

  it.effect("asks for an email address before reaching Clerk", () =>
    Effect.gen(function* () {
      const error = actionError(
        yield* runAction(underTest, "create-user", {
          input: { emailAddress: "" },
          credentials: credentialsRead(),
        })
      );

      expect(error.message).toBe("Email address is required.");
      expect(requests).toHaveLength(0);
    })
  );

  // Metadata the author meant to attach and mistyped fails the step: a user
  // created without it is a silent wrong answer.
  it.effect("refuses metadata that is not a JSON object", () =>
    Effect.gen(function* () {
      const error = actionError(
        yield* runAction(underTest, "create-user", {
          input: { emailAddress: "ada@example.com", privateMetadata: "[1, 2]" },
          credentials: credentialsRead(),
        })
      );

      expect(error.message).toBe("Invalid JSON format for privateMetadata");
      expect(requests).toHaveLength(0);
    })
  );

  it.effect("reports the message Clerk's error carries", () =>
    Effect.gen(function* () {
      stubFetch(() =>
        Response.json(
          {
            errors: [
              {
                message: "That email address is taken. Please try another.",
                long_message:
                  "That email address is taken. Please try another.",
                code: "form_identifier_exists",
                meta: { param_name: "email_address" },
              },
            ],
          },
          { status: 422 }
        )
      );

      const error = actionError(
        yield* runAction(underTest, "create-user", {
          input: { emailAddress: "ada@example.com" },
          credentials: credentialsRead(),
        })
      );

      expect(error.message).toBe(
        "Failed to create user: That email address is taken. Please try another."
      );
    })
  );
});

describe("clerk/update-user", () => {
  // A blank box leaves what Clerk already holds alone, which is what dropping
  // the field rather than sending it empty buys.
  it.effect("sends only the fields that were filled in", () =>
    Effect.gen(function* () {
      const result = actionData(
        yield* runAction(underTest, "update-user", {
          input: { userId: "user_1", lastName: "Byron" },
          credentials: credentialsRead(),
        })
      );

      expect(sentRequests()).toEqual([
        "PATCH https://api.clerk.com/v1/users/user_1",
      ]);
      expect(yield* sentBody(0)).toEqual({ last_name: "Byron" });
      expect(result).toEqual(FLATTENED_USER);
    })
  );

  // Clerk takes metadata on its own endpoint, which replaces each metadata
  // field the request carries.
  it.effect("replaces the metadata that was filled in", () =>
    Effect.gen(function* () {
      const result = actionData(
        yield* runAction(underTest, "update-user", {
          input: {
            userId: "user_1",
            firstName: "Ada",
            publicMetadata: '{"role":"admin"}',
          },
          credentials: credentialsRead(),
        })
      );

      expect(sentRequests()).toEqual([
        "PATCH https://api.clerk.com/v1/users/user_1",
        "PUT https://api.clerk.com/v1/users/user_1/metadata",
      ]);
      expect(yield* sentBody(0)).toEqual({ first_name: "Ada" });
      expect(yield* sentBody(1)).toEqual({
        public_metadata: { role: "admin" },
      });
      expect(result).toEqual(FLATTENED_USER);
    })
  );

  it.effect("asks for a user id before reaching Clerk", () =>
    Effect.gen(function* () {
      const error = actionError(
        yield* runAction(underTest, "update-user", {
          input: { userId: "" },
          credentials: credentialsRead(),
        })
      );

      expect(error.message).toBe("User ID is required.");
      expect(requests).toHaveLength(0);
    })
  );

  it.effect("refuses metadata that is not a JSON object", () =>
    Effect.gen(function* () {
      const error = actionError(
        yield* runAction(underTest, "update-user", {
          input: { userId: "user_1", publicMetadata: "not json" },
          credentials: credentialsRead(),
        })
      );

      expect(error.message).toBe("Invalid JSON format for publicMetadata");
      expect(requests).toHaveLength(0);
    })
  );

  // A refusal whose body is not Clerk's error shape has only its status to
  // report.
  it.effect("reports the status when Clerk's error carries no message", () =>
    Effect.gen(function* () {
      stubFetch(() => new Response(null, { status: 422 }));

      const error = actionError(
        yield* runAction(underTest, "update-user", {
          input: { userId: "user_1" },
          credentials: credentialsRead(),
        })
      );

      expect(error.message).toBe("Failed to update user: 422");
    })
  );
});

describe("clerk/delete-user", () => {
  it.effect("answers with the flag the action offers downstream", () =>
    Effect.gen(function* () {
      stubFetch(() =>
        Response.json({ object: "user", id: "user_1", deleted: true })
      );

      const result = actionData(
        yield* runAction(underTest, "delete-user", {
          input: { userId: "user_1" },
          credentials: credentialsRead(),
        })
      );

      expect(sentRequests()).toEqual([
        "DELETE https://api.clerk.com/v1/users/user_1",
      ]);
      expect(result).toEqual({ deleted: true });
    })
  );

  it.effect("asks for a user id before reaching Clerk", () =>
    Effect.gen(function* () {
      const error = actionError(
        yield* runAction(underTest, "delete-user", {
          input: { userId: "" },
          credentials: credentialsRead(),
        })
      );

      expect(error.message).toBe("User ID is required.");
      expect(requests).toHaveLength(0);
    })
  );

  it.effect("reports the message Clerk's error carries", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json(RESOURCE_NOT_FOUND, { status: 404 }));

      const error = actionError(
        yield* runAction(underTest, "delete-user", {
          input: { userId: "user_1" },
          credentials: credentialsRead(),
        })
      );

      expect(error.message).toBe("Failed to delete user: not found");
    })
  );
});
