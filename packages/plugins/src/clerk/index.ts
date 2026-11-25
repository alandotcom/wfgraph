/**
 * The Clerk integration: its credentials, its four actions, and what each takes
 * and gives back.
 *
 * One file, because only the server imports it. The editor gets this plugin's
 * metadata as JSON over `/api/extensions`, so nothing here reaches a browser
 * bundle. The icon is the exception, because a React component cannot be
 * serialized: it stays in `ui.ts`, which only the browser imports. Clerk's
 * Backend API itself is `client.ts`.
 */

import {
  type CredentialFields,
  type CredentialsOf,
  defineIntegration,
  StepFailure,
} from "@wfgraph/core/plugin";
import { Effect, Schema } from "effect";
import {
  createClerkUser,
  deleteClerkUser,
  describeClerkFailure,
  getClerkUser,
  updateClerkUser,
} from "#src/clerk/client";
import { parseClerkMetadata } from "#src/clerk/metadata";
import { testClerk } from "#src/clerk/test";
import { toClerkUserData } from "#src/clerk/types";

const clerkCredentialFields = {
  CLERK_SECRET_KEY: {
    label: "Secret Key",
    type: "password",
    placeholder: "sk_live_... or sk_test_...",
    helpText: "Get your secret key from ",
    helpLink: {
      text: "Clerk Dashboard",
      url: "https://dashboard.clerk.com",
    },
  },
} satisfies CredentialFields;

export type ClerkCredentials = CredentialsOf<typeof clerkCredentialFields>;

/**
 * The user three of the four actions answer with, flattened out of Clerk's
 * resource: the primary address is picked out of the address list, and the
 * metadata objects stay behind, because a downstream node has no shape to
 * address them by.
 *
 * The three Clerk may have nothing to give are `optionalKey(NullOr(...))`, which is
 * the one spelling that survives an absent key and an explicit null alike. The
 * condition builder reads `nullable` off it and offers the null checks, which is the
 * right question about a missing name.
 */
const clerkUserOutput = {
  id: Schema.String.annotate({ title: "User ID" }),
  firstName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  lastName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  primaryEmailAddress: Schema.optionalKey(Schema.NullOr(Schema.String)),
  // A bare `Schema.Number` describes itself as a number or one of the strings
  // "Infinity", "-Infinity" and "NaN", which the field reader cannot use, so
  // the field would drop out of the derived list. The check is what keeps it.
  createdAt: Schema.Number.annotate({
    description: "When the user was created, epoch milliseconds",
  }).check(Schema.isFinite()),
  updatedAt: Schema.Number.annotate({
    description: "When the user was last updated, epoch milliseconds",
  }).check(Schema.isFinite()),
};

const getUserInput = Schema.Struct({
  userId: Schema.String,
});

const getUserOutput = Schema.Struct(clerkUserOutput);

/** `optionalKey` for a field a builder may leave blank: it reaches a step absent. */
const createUserInput = Schema.Struct({
  emailAddress: Schema.String,
  firstName: Schema.optionalKey(Schema.String),
  lastName: Schema.optionalKey(Schema.String),
  password: Schema.optionalKey(Schema.String),
  /** JSON the workflow author typed, parsed by the step. */
  publicMetadata: Schema.optionalKey(Schema.String),
  privateMetadata: Schema.optionalKey(Schema.String),
});

const createUserOutput = Schema.Struct(clerkUserOutput);

const updateUserInput = Schema.Struct({
  userId: Schema.String,
  firstName: Schema.optionalKey(Schema.String),
  lastName: Schema.optionalKey(Schema.String),
  publicMetadata: Schema.optionalKey(Schema.String),
  privateMetadata: Schema.optionalKey(Schema.String),
});

const updateUserOutput = Schema.Struct(clerkUserOutput);

const deleteUserInput = Schema.Struct({
  userId: Schema.String,
});

const deleteUserOutput = Schema.Struct({
  deleted: Schema.Boolean.annotate({ title: "Deletion success" }),
});

export const clerk = defineIntegration({
  type: "clerk",
  label: "Clerk",
  description: "User authentication and management",
  credentials: clerkCredentialFields,

  test: testClerk,

  actions: {
    "get-user": {
      label: "Get User",
      description: "Fetch a user by ID from Clerk",
      input: getUserInput,
      output: getUserOutput,
      configFields: [
        {
          key: "userId",
          label: "User ID",
          type: "template-input",
          placeholder: "user_... or {{NodeName.userId}}",
          example: "user_2abc123",
          required: true,
        },
      ],
      handler: Effect.fn(function* (bag) {
        const { input } = bag;
        const credentials = yield* bag.credentials;
        const secretKey = credentials.CLERK_SECRET_KEY;

        if (!secretKey) {
          return yield* new StepFailure({
            message:
              "CLERK_SECRET_KEY is not configured. Please add it in Project Integrations.",
          });
        }

        if (!input.userId) {
          return yield* new StepFailure({ message: "User ID is required." });
        }

        // The step remembers the flat user, which is all the action answers
        // with, rather than the whole resource Clerk sent.
        return yield* bag.step.run(
          "get-user",
          getClerkUser(secretKey, input.userId).pipe(
            Effect.mapBoth({
              onSuccess: toClerkUserData,
              onFailure: (error) =>
                new StepFailure({
                  message: `Failed to get user: ${describeClerkFailure(error)}`,
                }),
            })
          )
        );
      }),
    },

    "create-user": {
      label: "Create User",
      description: "Create a new user in Clerk",
      sideEffect: true,
      input: createUserInput,
      output: createUserOutput,
      configFields: [
        {
          key: "emailAddress",
          label: "Email Address",
          type: "template-input",
          placeholder: "user@example.com or {{NodeName.email}}",
          example: "user@example.com",
          required: true,
        },
        {
          key: "firstName",
          label: "First Name",
          type: "template-input",
          placeholder: "John or {{NodeName.firstName}}",
          example: "John",
        },
        {
          key: "lastName",
          label: "Last Name",
          type: "template-input",
          placeholder: "Doe or {{NodeName.lastName}}",
          example: "Doe",
        },
        {
          key: "password",
          label: "Password",
          type: "template-input",
          placeholder: "Password (min 8 chars) or leave empty",
          example: "securepassword123",
        },
        {
          label: "Metadata",
          type: "group",
          defaultExpanded: false,
          fields: [
            {
              key: "publicMetadata",
              label: "Public Metadata (JSON)",
              type: "template-textarea",
              placeholder: '{"role": "admin"} or {{NodeName.metadata}}',
              rows: 3,
            },
            {
              key: "privateMetadata",
              label: "Private Metadata (JSON)",
              type: "template-textarea",
              placeholder: '{"internal_id": "123"}',
              rows: 3,
            },
          ],
        },
      ],
      handler: Effect.fn(function* (bag) {
        const { input } = bag;
        const credentials = yield* bag.credentials;
        const secretKey = credentials.CLERK_SECRET_KEY;

        if (!secretKey) {
          return yield* new StepFailure({
            message:
              "CLERK_SECRET_KEY is not configured. Please add it in Project Integrations.",
          });
        }

        if (!input.emailAddress) {
          return yield* new StepFailure({
            message: "Email address is required.",
          });
        }

        const publicMetadata = yield* parseClerkMetadata(
          input.publicMetadata,
          "publicMetadata"
        );
        const privateMetadata = yield* parseClerkMetadata(
          input.privateMetadata,
          "privateMetadata"
        );

        // Clerk's own field names. Clerk reads an absent field differently from
        // an empty one, so the client drops the fields left undefined here.
        return yield* bag.step.run(
          "create-user",
          createClerkUser(secretKey, {
            email_address: [input.emailAddress],
            first_name: input.firstName,
            last_name: input.lastName,
            password: input.password,
            public_metadata: publicMetadata,
            private_metadata: privateMetadata,
          }).pipe(
            Effect.mapBoth({
              onSuccess: toClerkUserData,
              onFailure: (error) =>
                new StepFailure({
                  message: `Failed to create user: ${describeClerkFailure(error)}`,
                }),
            })
          )
        );
      }),
    },

    "update-user": {
      label: "Update User",
      description: "Update an existing user in Clerk",
      sideEffect: true,
      input: updateUserInput,
      output: updateUserOutput,
      configFields: [
        {
          key: "userId",
          label: "User ID",
          type: "template-input",
          placeholder: "user_... or {{NodeName.user.id}}",
          example: "user_2abc123",
          required: true,
        },
        {
          key: "firstName",
          label: "First Name",
          type: "template-input",
          placeholder: "Jane or {{NodeName.firstName}}",
        },
        {
          key: "lastName",
          label: "Last Name",
          type: "template-input",
          placeholder: "Doe or {{NodeName.lastName}}",
        },
        {
          label: "Metadata",
          type: "group",
          defaultExpanded: false,
          fields: [
            {
              key: "publicMetadata",
              label: "Public Metadata (JSON)",
              type: "template-textarea",
              placeholder: '{"role": "admin"} or {{NodeName.metadata}}',
              rows: 3,
            },
            {
              key: "privateMetadata",
              label: "Private Metadata (JSON)",
              type: "template-textarea",
              placeholder: '{"internal_id": "123"}',
              rows: 3,
            },
          ],
        },
      ],
      handler: Effect.fn(function* (bag) {
        const { input } = bag;
        const credentials = yield* bag.credentials;
        const secretKey = credentials.CLERK_SECRET_KEY;

        if (!secretKey) {
          return yield* new StepFailure({
            message:
              "CLERK_SECRET_KEY is not configured. Please add it in Project Integrations.",
          });
        }

        if (!input.userId) {
          return yield* new StepFailure({ message: "User ID is required." });
        }

        const publicMetadata = yield* parseClerkMetadata(
          input.publicMetadata,
          "publicMetadata"
        );
        const privateMetadata = yield* parseClerkMetadata(
          input.privateMetadata,
          "privateMetadata"
        );

        // An update sends only the fields the user filled in, so a blank box
        // leaves what Clerk already holds alone rather than clearing it.
        return yield* bag.step.run(
          "update-user",
          updateClerkUser(secretKey, input.userId, {
            first_name: input.firstName,
            last_name: input.lastName,
            public_metadata: publicMetadata,
            private_metadata: privateMetadata,
          }).pipe(
            Effect.mapBoth({
              onSuccess: toClerkUserData,
              onFailure: (error) =>
                new StepFailure({
                  message: `Failed to update user: ${describeClerkFailure(error)}`,
                }),
            })
          )
        );
      }),
    },

    "delete-user": {
      label: "Delete User",
      description: "Delete a user from Clerk",
      sideEffect: true,
      input: deleteUserInput,
      output: deleteUserOutput,
      configFields: [
        {
          key: "userId",
          label: "User ID",
          type: "template-input",
          placeholder: "user_... or {{NodeName.user.id}}",
          example: "user_2abc123",
          required: true,
        },
      ],
      handler: Effect.fn(function* (bag) {
        const { input } = bag;
        const credentials = yield* bag.credentials;
        const secretKey = credentials.CLERK_SECRET_KEY;

        if (!secretKey) {
          return yield* new StepFailure({
            message:
              "CLERK_SECRET_KEY is not configured. Please add it in Project Integrations.",
          });
        }

        if (!input.userId) {
          return yield* new StepFailure({ message: "User ID is required." });
        }

        // This step reports on none of Clerk's deleted-object answer, so
        // nothing of it is remembered.
        yield* bag.step.run(
          "delete-user",
          deleteClerkUser(secretKey, input.userId).pipe(
            Effect.asVoid,
            Effect.mapError(
              (error) =>
                new StepFailure({
                  message: `Failed to delete user: ${describeClerkFailure(error)}`,
                })
            )
          )
        );

        return { deleted: true };
      }),
    },
  },
});
