import { describe, expect, it } from "@effect/vitest";
import { actionData, actionError, runAction } from "@wfgraph/core/testing";
import { Effect } from "effect";
import { clerk } from "#src/clerk/index";
import { clerkResponses } from "#src/clerk/responses.fixtures";
import { recordFetch } from "#src/fetch-test-support";

const underTest = clerk();

/**
 * The four Clerk steps in one file, because each has the same things to say:
 * which credential is missing, which field the action cannot do without, what
 * Clerk's user looks like flattened, and which prefix the step puts in front of
 * Clerk's refusal. The seam under all of them is `fetch`, so a case says what
 * Clerk answered and reads back both the step's answer and the request it sent.
 * What each request looks like in full, and how a refusal is worded, is
 * `client.test.ts`'s subject.
 */

const CLERK_CREDENTIALS = { CLERK_SECRET_KEY: "sk_test_key" };

/** `clerkResponses.user` as the three user-returning steps answer with it. */
const FLATTENED_USER = {
  id: "user_2abc123",
  firstName: "Ada",
  lastName: "Lovelace",
  primaryEmailAddress: "ada@example.com",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_001_000,
};

const wire = recordFetch(() => Response.json(clerkResponses.user));

/** The method and URL of each request sent, in order. */
function sentRequests(): string[] {
  return wire.requests.map((request) => `${request.method} ${request.url}`);
}

/** The credentials a run would have fetched. */
function credentialsRead(
  values: Record<string, string | undefined> = CLERK_CREDENTIALS
) {
  return Effect.sync(() => values);
}

describe("clerk/get-user", () => {
  it.effect("flattens Clerk's user around its primary address", () =>
    Effect.gen(function* () {
      const result = actionData(
        yield* runAction(underTest, "get-user", {
          input: { userId: "user_2abc123" },
          credentials: credentialsRead(),
        })
      );

      expect(sentRequests()).toEqual([
        "GET https://api.clerk.com/v1/users/user_2abc123",
      ]);
      expect(wire.requests[0]?.headers.get("authorization")).toBe(
        "Bearer sk_test_key"
      );
      expect(result).toEqual(FLATTENED_USER);
    })
  );

  it.effect("names the missing credential before reaching Clerk", () =>
    Effect.gen(function* () {
      const error = actionError(
        yield* runAction(underTest, "get-user", {
          input: { userId: "user_2abc123" },
          credentials: credentialsRead({}),
        })
      );

      expect(error.message).toBe(
        "CLERK_SECRET_KEY is not configured. Please add it in Project Integrations."
      );
      expect(wire.requests).toHaveLength(0);
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
      expect(wire.requests).toHaveLength(0);
    })
  );

  it.effect("puts its own prefix in front of Clerk's refusal", () =>
    Effect.gen(function* () {
      wire.answer(() =>
        Response.json(clerkResponses.resourceNotFound, { status: 404 })
      );

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
      expect(wire.body(0)).toEqual({
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
      expect(wire.requests).toHaveLength(0);
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
      expect(wire.requests).toHaveLength(0);
    })
  );

  it.effect("puts its own prefix in front of Clerk's refusal", () =>
    Effect.gen(function* () {
      wire.answer(() =>
        Response.json(clerkResponses.formIdentifierExists, { status: 422 })
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
          input: { userId: "user_2abc123", lastName: "Byron" },
          credentials: credentialsRead(),
        })
      );

      expect(sentRequests()).toEqual([
        "PATCH https://api.clerk.com/v1/users/user_2abc123",
      ]);
      expect(wire.body(0)).toEqual({ last_name: "Byron" });
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
            userId: "user_2abc123",
            firstName: "Ada",
            publicMetadata: '{"role":"admin"}',
          },
          credentials: credentialsRead(),
        })
      );

      expect(sentRequests()).toEqual([
        "PATCH https://api.clerk.com/v1/users/user_2abc123",
        "PUT https://api.clerk.com/v1/users/user_2abc123/metadata",
      ]);
      expect(wire.body(0)).toEqual({ first_name: "Ada" });
      expect(wire.body(1)).toEqual({
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
      expect(wire.requests).toHaveLength(0);
    })
  );

  it.effect("refuses metadata that is not a JSON object", () =>
    Effect.gen(function* () {
      const error = actionError(
        yield* runAction(underTest, "update-user", {
          input: { userId: "user_2abc123", publicMetadata: "not json" },
          credentials: credentialsRead(),
        })
      );

      expect(error.message).toBe("Invalid JSON format for publicMetadata");
      expect(wire.requests).toHaveLength(0);
    })
  );

  it.effect("puts its own prefix in front of Clerk's refusal", () =>
    Effect.gen(function* () {
      wire.answer(() => new Response(null, { status: 422 }));

      const error = actionError(
        yield* runAction(underTest, "update-user", {
          input: { userId: "user_2abc123" },
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
      wire.answer(() => Response.json(clerkResponses.deletedUser));

      const result = actionData(
        yield* runAction(underTest, "delete-user", {
          input: { userId: "user_2abc123" },
          credentials: credentialsRead(),
        })
      );

      expect(sentRequests()).toEqual([
        "DELETE https://api.clerk.com/v1/users/user_2abc123",
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
      expect(wire.requests).toHaveLength(0);
    })
  );

  it.effect("puts its own prefix in front of Clerk's refusal", () =>
    Effect.gen(function* () {
      wire.answer(() =>
        Response.json(clerkResponses.resourceNotFound, { status: 404 })
      );

      const error = actionError(
        yield* runAction(underTest, "delete-user", {
          input: { userId: "user_2abc123" },
          credentials: credentialsRead(),
        })
      );

      expect(error.message).toBe("Failed to delete user: not found");
    })
  );
});
