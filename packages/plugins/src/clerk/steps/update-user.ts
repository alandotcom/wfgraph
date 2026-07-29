import {
  defineStep,
  StepFailure,
  type StepRunContext,
} from "@rova/core/plugin";
import { omitBy } from "es-toolkit/object";
import { isNil } from "es-toolkit/predicate";
import { Effect } from "effect";
import {
  createClerkBackendClient,
  getClerkApiErrorMessage,
  toClerkApiUser,
} from "#src/clerk/client";
import type { ClerkCredentials } from "#src/clerk/credentials";
import { parseClerkMetadata } from "#src/clerk/metadata";
import { updateUserInput, updateUserOutput } from "#src/clerk/schemas";
import { toClerkUserData } from "#src/clerk/types";

/**
 * Named rather than written inline, so a test can run it with a context it
 * supplies.
 */
export const clerkUpdateUserHandler = Effect.fn(function* (
  input: typeof updateUserInput.Type,
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

  const publicMetadata = yield* parseClerkMetadata(
    input.publicMetadata,
    "publicMetadata"
  );
  const privateMetadata = yield* parseClerkMetadata(
    input.privateMetadata,
    "privateMetadata"
  );

  const clerk = createClerkBackendClient(secretKey);
  // An update sends only the fields the user filled in, so a blank box leaves
  // what Clerk already holds alone rather than clearing it.
  const updatePayload = omitBy(
    {
      firstName: input.firstName,
      lastName: input.lastName,
      publicMetadata,
      privateMetadata,
    },
    isNil
  );

  const user = yield* Effect.tryPromise({
    try: () => clerk.users.updateUser(input.userId, updatePayload),
    catch: (error) =>
      new StepFailure({
        message: `Failed to update user: ${getClerkApiErrorMessage(error)}`,
      }),
  });

  return toClerkUserData(toClerkApiUser(user));
});

export const clerkUpdateUserStep = defineStep({
  id: "clerk/update-user",
  input: updateUserInput,
  output: updateUserOutput,
  handler: clerkUpdateUserHandler,
});
