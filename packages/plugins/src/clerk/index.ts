/**
 * The Clerk integration: its credentials, its four actions, and what each takes
 * and gives back.
 *
 * The handlers are not here. Clerk's SDK is a runtime import of `client.ts`, so
 * `load` is what keeps it out of a process that never runs a Clerk action: a
 * handler's module is imported the first time its action runs. The schemas are
 * exported for those modules to type themselves against.
 *
 * Only the server imports this. The editor gets the metadata below as JSON over
 * `/api/extensions`, and the icon stays in `ui.ts`.
 */

import {
  credentialFields,
  type CredentialsOf,
  defineIntegration,
  defineStep,
} from "@rova/core/plugin";
import { Schema } from "effect";

const clerkCredentialFields = credentialFields([
  {
    label: "Secret Key",
    type: "password",
    placeholder: "sk_live_... or sk_test_...",
    configKey: "clerkSecretKey",
    envVar: "CLERK_SECRET_KEY",
    helpText: "Get your secret key from ",
    helpLink: {
      text: "Clerk Dashboard",
      url: "https://dashboard.clerk.com",
    },
  },
]);

export type ClerkCredentials = CredentialsOf<typeof clerkCredentialFields>;

/**
 * The user three of the four actions answer with, flattened out of Clerk's
 * resource: the primary address is picked out of the address list, and the
 * metadata objects stay behind, since a downstream node has no shape to address
 * them by.
 *
 * The three Clerk may have nothing to give are `optionalKey(NullOr(...))`, which is
 * the one spelling that survives an absent key and an explicit null alike. The
 * condition builder reads `nullable` off it and offers the null checks, which is the
 * right question about a missing name.
 */
const clerkUserOutput = {
  id: Schema.String.annotate({ description: "User ID" }),
  firstName: Schema.optionalKey(
    Schema.NullOr(Schema.String.annotate({ description: "First name" }))
  ),
  lastName: Schema.optionalKey(
    Schema.NullOr(Schema.String.annotate({ description: "Last name" }))
  ),
  primaryEmailAddress: Schema.optionalKey(
    Schema.NullOr(
      Schema.String.annotate({ description: "Primary email address" })
    )
  ),
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

export const getUserInput = Schema.Struct({
  userId: Schema.String,
});

const getUserOutput = Schema.Struct(clerkUserOutput);

/** `optionalKey` for a field a builder may leave blank: it reaches a step absent. */
export const createUserInput = Schema.Struct({
  emailAddress: Schema.String,
  firstName: Schema.optionalKey(Schema.String),
  lastName: Schema.optionalKey(Schema.String),
  password: Schema.optionalKey(Schema.String),
  /** JSON the workflow author typed, parsed by the step. */
  publicMetadata: Schema.optionalKey(Schema.String),
  privateMetadata: Schema.optionalKey(Schema.String),
});

const createUserOutput = Schema.Struct(clerkUserOutput);

export const updateUserInput = Schema.Struct({
  userId: Schema.String,
  firstName: Schema.optionalKey(Schema.String),
  lastName: Schema.optionalKey(Schema.String),
  publicMetadata: Schema.optionalKey(Schema.String),
  privateMetadata: Schema.optionalKey(Schema.String),
});

const updateUserOutput = Schema.Struct(clerkUserOutput);

export const deleteUserInput = Schema.Struct({
  userId: Schema.String,
});

const deleteUserOutput = Schema.Struct({
  deleted: Schema.Boolean.annotate({ description: "Deletion success" }),
});

export const clerk = defineIntegration({
  type: "clerk",
  label: "Clerk",
  description: "User authentication and management",
  credentials: clerkCredentialFields,

  test: async () => (await import("#src/clerk/test")).testClerk,

  actions: {
    "get-user": defineStep({
      label: "Get User",
      description: "Fetch a user by ID from Clerk",
      category: "Clerk",
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
      load: async () =>
        (await import("#src/clerk/steps/get-user")).clerkGetUserHandler,
    }),

    "create-user": defineStep({
      label: "Create User",
      description: "Create a new user in Clerk",
      category: "Clerk",
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
      load: async () =>
        (await import("#src/clerk/steps/create-user")).clerkCreateUserHandler,
    }),

    "update-user": defineStep({
      label: "Update User",
      description: "Update an existing user in Clerk",
      category: "Clerk",
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
      load: async () =>
        (await import("#src/clerk/steps/update-user")).clerkUpdateUserHandler,
    }),

    "delete-user": defineStep({
      label: "Delete User",
      description: "Delete a user from Clerk",
      category: "Clerk",
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
      load: async () =>
        (await import("#src/clerk/steps/delete-user")).clerkDeleteUserHandler,
    }),
  },
});
