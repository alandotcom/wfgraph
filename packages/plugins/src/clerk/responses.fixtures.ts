/**
 * Clerk Backend API response bodies, as version 2026-08-20 of Clerk's
 * reference documents them, for the Clerk tests to answer with.
 */

import type { JsonObject } from "@wfgraph/shared/types/json";

/** A verified address on the User object, with every required property. */
function emailAddress(id: string, address: string): JsonObject {
  return {
    id,
    object: "email_address",
    email_address: address,
    reserved: false,
    verification: {
      object: "verification_admin",
      status: "verified",
      strategy: "admin",
      attempts: null,
      expire_at: null,
    },
    linked_to: [],
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
  };
}

export const clerkResponses = {
  /**
   * A User object with every property Clerk's reference marks required, so a
   * decode is checked against the whole resource. The primary address is the
   * second entry in `email_addresses`, so reading it means matching its id.
   */
  user: {
    id: "user_2abc123",
    object: "user",
    username: null,
    first_name: "Ada",
    last_name: "Lovelace",
    has_image: false,
    primary_email_address_id: "idn_primary",
    primary_phone_number_id: null,
    primary_web3_wallet_id: null,
    password_enabled: false,
    two_factor_enabled: false,
    totp_enabled: false,
    backup_code_enabled: false,
    email_addresses: [
      emailAddress("idn_other", "other@example.com"),
      emailAddress("idn_primary", "ada@example.com"),
    ],
    phone_numbers: [],
    web3_wallets: [],
    passkeys: [],
    external_accounts: [],
    saml_accounts: [],
    enterprise_accounts: [],
    public_metadata: { role: "admin" },
    private_metadata: {},
    external_id: null,
    last_sign_in_at: null,
    banned: false,
    locked: false,
    lockout_expires_in_seconds: null,
    verification_attempts_remaining: 100,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_001_000,
    delete_self_enabled: true,
    create_organization_enabled: true,
    last_active_at: null,
    mfa_enabled_at: null,
    mfa_disabled_at: null,
    legal_accepted_at: null,
  },

  /** The DeletedObject that answers `DELETE /users/{user_id}`. */
  deletedUser: { object: "user", id: "user_2abc123", deleted: true },

  /** Clerk's documented `ResourceNotFound` error, status 404. */
  resourceNotFound: {
    errors: [
      {
        message: "not found",
        long_message: "Resource not found",
        code: "resource_not_found",
      },
    ],
  },

  /** Clerk's documented `FormIdentifierExists` error, status 422. */
  formIdentifierExists: {
    errors: [
      {
        message: "That email address is taken. Please try another.",
        long_message: "That email address is taken. Please try another.",
        code: "form_identifier_exists",
        meta: { param_name: "email_address" },
      },
    ],
    clerk_trace_id: "trace_1",
  },

  /** Clerk's refusal of a secret key it does not accept, status 401. */
  secretKeyInvalid: {
    errors: [
      {
        message:
          "The provided Clerk Secret Key is invalid. Make sure that your Clerk Secret Key is correct.",
        long_message:
          "The provided Clerk Secret Key is invalid. Make sure that your Clerk Secret Key is correct.",
        code: "clerk_key_invalid",
      },
    ],
  },
} satisfies Record<string, JsonObject>;
