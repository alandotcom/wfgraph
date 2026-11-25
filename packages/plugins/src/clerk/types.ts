/**
 * Clerk's user resource as the Backend API sends it, and the flat user the
 * Clerk steps answer with.
 */

import { Schema } from "effect";

/**
 * One entry of a user's `email_addresses` list. Clerk's reference lists `id` as
 * an optional property of the EmailAddress object, so a decode accepts an entry
 * without one, and such an entry never matches the primary address id.
 */
const clerkEmailAddressSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  email_address: Schema.String,
});

/**
 * The User object Clerk's Backend API answers with, holding the fields
 * `toClerkUserData` reads. Clerk sends many more, and a decode ignores them.
 * `created_at` and `updated_at` are Unix timestamps in milliseconds.
 */
export const clerkApiUserSchema = Schema.Struct({
  id: Schema.String,
  first_name: Schema.NullOr(Schema.String),
  last_name: Schema.NullOr(Schema.String),
  email_addresses: Schema.Array(clerkEmailAddressSchema),
  primary_email_address_id: Schema.NullOr(Schema.String),
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
});

export type ClerkApiUser = typeof clerkApiUserSchema.Type;

/**
 * Flat user data for workflow steps
 */
export type ClerkUserData = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  primaryEmailAddress: string | null;
  createdAt: number;
  updatedAt: number;
};

/**
 * Clerk's user resource as the three user-returning steps answer with it: the
 * primary address picked out of the address list, and the metadata objects left
 * behind, because a downstream node has no shape to address them by.
 */
export function toClerkUserData(apiUser: ClerkApiUser): ClerkUserData {
  const primaryEmail = apiUser.email_addresses.find(
    (e) => e.id === apiUser.primary_email_address_id
  );
  return {
    id: apiUser.id,
    firstName: apiUser.first_name,
    lastName: apiUser.last_name,
    primaryEmailAddress: primaryEmail?.email_address ?? null,
    createdAt: apiUser.created_at,
    updatedAt: apiUser.updated_at,
  };
}
