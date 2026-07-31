import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { beforeEach, vi } from "vitest";
import {
  clerkCreateUserHandler,
  clerkDeleteUserHandler,
  clerkGetUserHandler,
  clerkUpdateUserHandler,
} from "#src/clerk/index";

/**
 * The four Clerk steps in one file, because what they have to say is the same
 * four things each: which credential is missing, which field the action cannot
 * do without, what Clerk's user looks like flattened, and how a thrown Clerk
 * error reads. The seam under all of them is `@clerk/backend`, whose users
 * resource is stubbed here.
 */
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock("#src/clerk/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/clerk/client")>()),
  createClerkBackendClient: mocks.createClient,
}));

const CLERK_CREDENTIALS = { CLERK_SECRET_KEY: "sk_test_key" };

// What Clerk's SDK hands back, in its own camelCase, so the step's flattening
// is exercised rather than assumed.
const CLERK_USER = {
  id: "user_1",
  firstName: "Ada",
  lastName: "Lovelace",
  emailAddresses: [
    { id: "idn_1", emailAddress: "ada@example.com" },
    { id: "idn_2", emailAddress: "other@example.com" },
  ],
  primaryEmailAddressId: "idn_1",
  publicMetadata: {},
  privateMetadata: {},
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_001_000,
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

/** The credentials a run would have fetched. */
function credentialsRead(
  values: Record<string, string | undefined> = CLERK_CREDENTIALS
) {
  return Effect.sync(() => values);
}

function contextFor(
  credentials: Effect.Effect<Record<string, string | undefined>>
) {
  return {
    runMode: "live" as const,
    nodeId: "n1",
    nodeName: "Clerk",
    nodeType: "action",
    integrationId: "int_clerk",
    credentials,
    readCredentials: () => Effect.runPromise(credentials),
  };
}

/** A step that succeeds fails the flip, which is what makes the test say so. */
const failure = Effect.flip;

const withTransport = Effect.provide(FetchHttpClient.layer);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createClient.mockReturnValue({
    users: {
      getUser: mocks.getUser,
      createUser: mocks.createUser,
      updateUser: mocks.updateUser,
      deleteUser: mocks.deleteUser,
    },
  });
  mocks.getUser.mockResolvedValue(CLERK_USER);
  mocks.createUser.mockResolvedValue(CLERK_USER);
  mocks.updateUser.mockResolvedValue(CLERK_USER);
  mocks.deleteUser.mockResolvedValue(undefined);
});

describe("clerkGetUserHandler", () => {
  it.effect("flattens Clerk's user around its primary address", () =>
    Effect.gen(function* () {
      const credentials = credentialsRead();

      const result = yield* clerkGetUserHandler(
        { userId: "user_1" },
        contextFor(credentials)
      );

      expect(mocks.getUser).toHaveBeenCalledWith("user_1");
      expect(result).toEqual(FLATTENED_USER);
    }).pipe(withTransport)
  );

  it.effect("names the missing credential before reaching Clerk", () =>
    Effect.gen(function* () {
      const credentials = credentialsRead({});

      const error = yield* failure(
        clerkGetUserHandler({ userId: "user_1" }, contextFor(credentials))
      );

      expect(error.message).toBe(
        "CLERK_SECRET_KEY is not configured. Please add it in Project Integrations."
      );
      expect(mocks.getUser).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );

  it.effect("asks for a user id before reaching Clerk", () =>
    Effect.gen(function* () {
      const credentials = credentialsRead();

      const error = yield* failure(
        clerkGetUserHandler({ userId: "" }, contextFor(credentials))
      );

      expect(error.message).toBe("User ID is required.");
      expect(mocks.getUser).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );

  // Clerk's SDK throws an object carrying a list of errors, and the first of
  // those is the sentence a user can act on.
  it.effect("reports the message Clerk's error carries", () =>
    Effect.gen(function* () {
      mocks.getUser.mockRejectedValue({
        status: 404,
        errors: [{ message: "Not Found" }],
      });
      const credentials = credentialsRead();

      const error = yield* failure(
        clerkGetUserHandler({ userId: "user_missing" }, contextFor(credentials))
      );

      expect(error.message).toBe("Failed to get user: Not Found");
    }).pipe(withTransport)
  );
});

describe("clerkCreateUserHandler", () => {
  it.effect("sends the address as the list Clerk takes", () =>
    Effect.gen(function* () {
      const credentials = credentialsRead();

      const result = yield* clerkCreateUserHandler(
        {
          emailAddress: "ada@example.com",
          firstName: "Ada",
          publicMetadata: '{"role":"admin"}',
        },
        contextFor(credentials)
      );

      expect(mocks.createUser).toHaveBeenCalledWith({
        emailAddress: ["ada@example.com"],
        firstName: "Ada",
        publicMetadata: { role: "admin" },
      });
      expect(result).toEqual(FLATTENED_USER);
    }).pipe(withTransport)
  );

  it.effect("asks for an email address before reaching Clerk", () =>
    Effect.gen(function* () {
      const credentials = credentialsRead();

      const error = yield* failure(
        clerkCreateUserHandler({ emailAddress: "" }, contextFor(credentials))
      );

      expect(error.message).toBe("Email address is required.");
      expect(mocks.createUser).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );

  // Metadata the author meant to attach and mistyped fails the step: a user
  // created without it is a silent wrong answer.
  it.effect("refuses metadata that is not a JSON object", () =>
    Effect.gen(function* () {
      const credentials = credentialsRead();

      const error = yield* failure(
        clerkCreateUserHandler(
          { emailAddress: "ada@example.com", privateMetadata: "[1, 2]" },
          contextFor(credentials)
        )
      );

      expect(error.message).toBe("Invalid JSON format for privateMetadata");
      expect(mocks.createUser).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );

  it.effect("reports the message Clerk's error carries", () =>
    Effect.gen(function* () {
      mocks.createUser.mockRejectedValue({
        errors: [{ message: "That email address is taken." }],
      });
      const credentials = credentialsRead();

      const error = yield* failure(
        clerkCreateUserHandler(
          { emailAddress: "ada@example.com" },
          contextFor(credentials)
        )
      );

      expect(error.message).toBe(
        "Failed to create user: That email address is taken."
      );
    }).pipe(withTransport)
  );
});

describe("clerkUpdateUserHandler", () => {
  // A blank box leaves what Clerk already holds alone, which is what dropping
  // the field rather than sending it empty buys.
  it.effect("sends only the fields that were filled in", () =>
    Effect.gen(function* () {
      const credentials = credentialsRead();

      const result = yield* clerkUpdateUserHandler(
        { userId: "user_1", lastName: "Byron" },
        contextFor(credentials)
      );

      expect(mocks.updateUser).toHaveBeenCalledWith("user_1", {
        lastName: "Byron",
      });
      expect(result).toEqual(FLATTENED_USER);
    }).pipe(withTransport)
  );

  it.effect("asks for a user id before reaching Clerk", () =>
    Effect.gen(function* () {
      const credentials = credentialsRead();

      const error = yield* failure(
        clerkUpdateUserHandler({ userId: "" }, contextFor(credentials))
      );

      expect(error.message).toBe("User ID is required.");
      expect(mocks.updateUser).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );

  it.effect("refuses metadata that is not a JSON object", () =>
    Effect.gen(function* () {
      const credentials = credentialsRead();

      const error = yield* failure(
        clerkUpdateUserHandler(
          { userId: "user_1", publicMetadata: "not json" },
          contextFor(credentials)
        )
      );

      expect(error.message).toBe("Invalid JSON format for publicMetadata");
      expect(mocks.updateUser).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );

  it.effect("reports the message Clerk's error carries", () =>
    Effect.gen(function* () {
      mocks.updateUser.mockRejectedValue({ status: 422 });
      const credentials = credentialsRead();

      const error = yield* failure(
        clerkUpdateUserHandler({ userId: "user_1" }, contextFor(credentials))
      );

      expect(error.message).toBe("Failed to update user: 422");
    }).pipe(withTransport)
  );
});

describe("clerkDeleteUserHandler", () => {
  it.effect("answers with the flag the action offers downstream", () =>
    Effect.gen(function* () {
      const credentials = credentialsRead();

      const result = yield* clerkDeleteUserHandler(
        { userId: "user_1" },
        contextFor(credentials)
      );

      expect(mocks.deleteUser).toHaveBeenCalledWith("user_1");
      expect(result).toEqual({ deleted: true });
    }).pipe(withTransport)
  );

  it.effect("asks for a user id before reaching Clerk", () =>
    Effect.gen(function* () {
      const credentials = credentialsRead();

      const error = yield* failure(
        clerkDeleteUserHandler({ userId: "" }, contextFor(credentials))
      );

      expect(error.message).toBe("User ID is required.");
      expect(mocks.deleteUser).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );

  it.effect("reports the message Clerk's error carries", () =>
    Effect.gen(function* () {
      mocks.deleteUser.mockRejectedValue({
        errors: [{ message: "Not Found" }],
      });
      const credentials = credentialsRead();

      const error = yield* failure(
        clerkDeleteUserHandler({ userId: "user_1" }, contextFor(credentials))
      );

      expect(error.message).toBe("Failed to delete user: Not Found");
    }).pipe(withTransport)
  );
});
