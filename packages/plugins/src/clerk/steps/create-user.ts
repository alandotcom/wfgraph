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
import { createUserInput, createUserOutput } from "#src/clerk/schemas";
import { toClerkUserData } from "#src/clerk/types";

/**
 * Named rather than written inline, so a test can run it with a context it
 * supplies.
 */
export const clerkCreateUserHandler = Effect.fn(function* (
  input: typeof createUserInput.Type,
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

  if (!input.emailAddress) {
    return yield* Effect.fail(
      new StepFailure({ message: "Email address is required." })
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
  // Clerk reads an absent field and a null one differently, so the fields the
  // user left blank are dropped rather than sent empty.
  const createPayload = omitBy(
    {
      emailAddress: [input.emailAddress],
      firstName: input.firstName,
      lastName: input.lastName,
      password: input.password,
      publicMetadata,
      privateMetadata,
    },
    isNil
  );

  const user = yield* Effect.tryPromise({
    try: () => clerk.users.createUser(createPayload),
    catch: (error) =>
      new StepFailure({
        message: `Failed to create user: ${getClerkApiErrorMessage(error)}`,
      }),
  });

  return toClerkUserData(toClerkApiUser(user));
});

export const clerkCreateUserStep = defineStep({
  id: "clerk/create-user",
  input: createUserInput,
  output: createUserOutput,
  handler: clerkCreateUserHandler,
});
