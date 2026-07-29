/**
 * What the Clerk actions take and what they give back.
 *
 * These sit beside the plugin's metadata rather than beside its steps because
 * both ends need them and only one end is server code: the action metadata in
 * `index.ts` is what the editor loads into the browser, and it derives the
 * template-autocomplete fields from the output schemas here, while the steps in
 * `steps/` are typed against the same constants.
 */

import { Schema } from "effect";

/**
 * The user three of the four actions answer with, flattened out of Clerk's
 * resource: the primary address is picked out of the address list, and the
 * metadata objects stay behind, since a downstream node has no shape to address
 * them by.
 *
 * `NullOr`, not `optional`, for the three Clerk may have nothing to give: the
 * flattening answers an explicit `null` for a user who set no name or whose
 * primary address is not among the addresses on file, and the key is there
 * either way. The condition builder reads the same `nullable` off both, so it
 * offers the null checks that are the right question about a missing name.
 */
const clerkUserOutput = {
  id: Schema.String.annotate({ description: "User ID" }),
  firstName: Schema.NullOr(
    Schema.String.annotate({ description: "First name" })
  ),
  lastName: Schema.NullOr(Schema.String.annotate({ description: "Last name" })),
  primaryEmailAddress: Schema.NullOr(
    Schema.String.annotate({ description: "Primary email address" })
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

export const getUserOutput = Schema.Struct(clerkUserOutput);

export const createUserInput = Schema.Struct({
  emailAddress: Schema.String,
  firstName: Schema.optional(Schema.String),
  lastName: Schema.optional(Schema.String),
  password: Schema.optional(Schema.String),
  /** JSON the workflow author typed, parsed by the step. */
  publicMetadata: Schema.optional(Schema.String),
  privateMetadata: Schema.optional(Schema.String),
});

export const createUserOutput = Schema.Struct(clerkUserOutput);

export const updateUserInput = Schema.Struct({
  userId: Schema.String,
  firstName: Schema.optional(Schema.String),
  lastName: Schema.optional(Schema.String),
  publicMetadata: Schema.optional(Schema.String),
  privateMetadata: Schema.optional(Schema.String),
});

export const updateUserOutput = Schema.Struct(clerkUserOutput);

export const deleteUserInput = Schema.Struct({
  userId: Schema.String,
});

export const deleteUserOutput = Schema.Struct({
  deleted: Schema.Boolean.annotate({ description: "Deletion success" }),
});
