import {
  defineStep,
  StepFailure,
  type StepRunContext,
} from "@rova/core/plugin";
import { Effect } from "effect";
import {
  createClerkBackendClient,
  getClerkApiErrorMessage,
} from "#src/clerk/client";
import type { ClerkCredentials } from "#src/clerk/credentials";
import { deleteUserInput, deleteUserOutput } from "#src/clerk/schemas";

/**
 * Named rather than written inline, so a test can run it with a context it
 * supplies.
 */
export const clerkDeleteUserHandler = Effect.fn(function* (
  input: typeof deleteUserInput.Type,
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

  yield* Effect.tryPromise({
    try: () => clerk.users.deleteUser(input.userId),
    catch: (error) =>
      new StepFailure({
        message: `Failed to delete user: ${getClerkApiErrorMessage(error)}`,
      }),
  });

  return { deleted: true };
});

export const clerkDeleteUserStep = defineStep({
  id: "clerk/delete-user",
  input: deleteUserInput,
  output: deleteUserOutput,
  handler: clerkDeleteUserHandler,
});
