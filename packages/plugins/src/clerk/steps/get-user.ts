import {
  defineStep,
  StepFailure,
  type StepRunContext,
} from "@rova/core/plugin";
import { Effect } from "effect";
import {
  createClerkBackendClient,
  getClerkApiErrorMessage,
  toClerkApiUser,
} from "#src/clerk/client";
import type { ClerkCredentials } from "#src/clerk/credentials";
import { getUserInput, getUserOutput } from "#src/clerk/schemas";
import { toClerkUserData } from "#src/clerk/types";

/**
 * Named rather than written inline, so a test can run it with a context it
 * supplies.
 */
export const clerkGetUserHandler = Effect.fn(function* (
  input: typeof getUserInput.Type,
  context: StepRunContext
) {
  // The plugin's own credential vocabulary, so a key it never declares is a
  // compile error here rather than an undefined at run time.
  const credentials: ClerkCredentials = yield* context.credentials;
  const secretKey = credentials.CLERK_SECRET_KEY;

  if (!secretKey) {
    return yield* Effect.fail(
      new StepFailure({
        message:
          "CLERK_SECRET_KEY is not configured. Please add it in Project Integrations.",
      })
    );
  }

  if (!input.userId) {
    return yield* Effect.fail(
      new StepFailure({ message: "User ID is required." })
    );
  }

  const clerk = createClerkBackendClient(secretKey);
  const user = yield* Effect.tryPromise({
    try: () => clerk.users.getUser(input.userId),
    catch: (error) =>
      new StepFailure({
        message: `Failed to get user: ${getClerkApiErrorMessage(error)}`,
      }),
  });

  return toClerkUserData(toClerkApiUser(user));
});

export const clerkGetUserStep = defineStep({
  id: "clerk/get-user",
  input: getUserInput,
  output: getUserOutput,
  handler: clerkGetUserHandler,
});
