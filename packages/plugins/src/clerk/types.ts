export type ClerkApiUser = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email_addresses: Array<{
    id: string;
    email_address: string;
  }>;
  primary_email_address_id: string | null;
  public_metadata: Record<string, unknown>;
  private_metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};

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
 * behind, since a downstream node has no shape to address them by.
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
